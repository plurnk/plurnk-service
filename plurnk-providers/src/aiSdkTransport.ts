import { isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
import { outboundFetch } from "@plurnk/plurnk-meta";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { APICallError, JSONParseError, TypeValidationError } from "./errors.ts";
import {
    chatMessageText,
    type CallWarning,
    type ChatMessage,
    type JSONValue,
    type LanguageModel,
    type LanguageModelCallOptions,
    type LanguageModelContentPart,
    type LanguageModelFinishReason,
    type LanguageModelGenerateResult,
    type LanguageModelPromptMessage,
    type LanguageModelStreamPart,
    type LanguageModelStreamResult,
    type LanguageModelUsage,
    type LanguageModelV4Usage,
    type ProviderAttemptFinishReason,
    type ProviderChargeEvidence,
    type ProviderReasoningObserver,
    type ProviderUsage,
    type TokenLogprob,
} from "./types.ts";
import { normalizeUsage, UsageDetailError } from "./usage.ts";
import { withoutNativeTools } from "./native-tools.ts";

export const retryDirective = (
    status: number | undefined,
    headers: Headers | Readonly<Record<string, string>>,
): boolean | null => {
    const raw = headers instanceof Headers
        ? headers.get("x-should-retry")
        : Object.entries(headers).find(([name]) => name.toLowerCase() === "x-should-retry")?.[1];
    const directive = raw?.trim().toLowerCase();
    if (directive === "false") return false;
    if (directive === "true") return true;
    if (status !== undefined && status >= 520 && status <= 527) return false;
    return null;
};

// {§provider-connectivity} (#479): a Retry-After header on any status is the
// provider directing a wait (RFC 9110 defines it on 503 exactly for this);
// its presence, like a bare 429, earns the bounded transport retry.
export const retryAfterPresent = (
    headers: Headers | Readonly<Record<string, string>>,
): boolean => {
    const raw = headers instanceof Headers
        ? headers.get("retry-after")
        : Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
    return raw !== undefined && raw !== null && raw.trim() !== "";
};

export const isResponseRetryable = (
    status: number,
    headers: Headers | Readonly<Record<string, string>>,
): boolean => retryDirective(status, headers)
    ?? (status === 429 || retryAfterPresent(headers));

export const headersToRecord = (headers: Headers): Record<string, string> => {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
        record[key] = value;
    });
    return record;
};

export const extractErrorMessage = (responseText: string, statusText: string, status: number): { message: string; data?: unknown } => {
    if (responseText.trim().length > 0) {
        try {
            const parsed: unknown = JSON.parse(responseText);
            if (isRecord(parsed)) {
                if (isRecord(parsed.error) && typeof parsed.error.message === "string" && parsed.error.message.trim().length > 0) {
                    return { message: parsed.error.message, data: parsed };
                }
                if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
                    return { message: parsed.message, data: parsed };
                }
                return { message: responseText, data: parsed };
            }
        } catch {
            // Non-JSON error body; keep raw text.
        }
        return { message: responseText };
    }
    return { message: statusText.trim().length > 0 ? statusText : `HTTP ${status}` };
};

export const encodeBytesBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
};

export const toUnifiedFinishReason = (
    raw: string | undefined,
): LanguageModelFinishReason["unified"] => {
    switch (raw) {
        case "stop":
        case "end_turn":
        case "stop_sequence":
        case "STOP":
            return "stop";
        case "length":
        case "max_tokens":
        case "MAX_TOKENS":
            return "length";
        case "tool_calls":
        case "tool-calls":
        case "tool_use":
        case "function_call":
            return "tool-calls";
        case "content_filter":
        case "content-filter":
        case "SAFETY":
        case "RECITATION":
        case "BLOCKLIST":
        case "PROHIBITED_CONTENT":
        case "SPII":
        case "IMAGE_SAFETY":
            return "content-filter";
        case "error":
        case "network_error":
        case "MALFORMED_FUNCTION_CALL":
            return "error";
        default:
            return "other";
    }
};

const baseUrl = (completionUrl: string): string => {
    const url = new URL(completionUrl);
    if (!url.pathname.endsWith("/chat/completions")) {
        throw new Error(`OpenAI-compatible URL must end in /chat/completions: ${completionUrl}`);
    }
    url.pathname = url.pathname.slice(0, -"/chat/completions".length);
    return url.toString().replace(/\/$/, "");
};

const usageOf = (
    usage: LanguageModelUsage,
): ProviderUsage | undefined => normalizeUsage({
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_cache_miss_tokens: usage.inputTokenDetails.noCacheTokens,
    prompt_tokens_details: {
        cached_tokens: usage.inputTokenDetails.cacheReadTokens,
        cache_write_tokens: usage.inputTokenDetails.cacheWriteTokens,
    },
    completion_tokens_details: usage.outputTokenDetails.reasoningTokens !== undefined
        ? { reasoning_tokens: usage.outputTokenDetails.reasoningTokens }
        : undefined,
});

const wireUsageOf = (
    values: readonly unknown[],
    sdkUsage: LanguageModelUsage | undefined,
): ProviderUsage | undefined => {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const usage = recordOf(values[index])?.usage;
        const raw = recordOf(usage);
        if (raw !== null && ("prompt_tokens" in raw || "completion_tokens" in raw || "total_tokens" in raw)) {
            return normalizeUsage(raw, sdkUsage === undefined ? undefined : {
                inputTokens: sdkUsage.inputTokens,
                inputTokenDetails: sdkUsage.inputTokenDetails,
            });
        }
    }
    return undefined;
};

// {§provider-usage-refusal} — the provider's bookkeeping is not the exchange.
// invalid details do not erase valid aggregates; contradictory aggregates remain unknown.
// The original counters ride beside the refusal, never clamped or replaced.
type UsageRefusal = { readonly reason: string; readonly usage: unknown };

const settledUsage = (
    values: readonly unknown[],
    sdkUsage: LanguageModelUsage | undefined,
): { usage?: ProviderUsage; usageRefusal?: UsageRefusal } => {
    try {
        const usage = wireUsageOf(values, sdkUsage) ?? (sdkUsage === undefined ? undefined : usageOf(sdkUsage));
        return usage === undefined ? {} : { usage };
    } catch (cause) {
        if (!(cause instanceof TypeError)) throw cause;
        return {
            ...(cause instanceof UsageDetailError ? { usage: cause.usage } : {}),
            usageRefusal: { reason: cause.message, usage: wireUsageEvidenceOf(values) ?? sdkUsage },
        };
    }
};

const wireUsageEvidenceOf = (values: readonly unknown[]): unknown => {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const record = recordOf(values[index]);
        if (record !== null && record.usage !== undefined) return record.usage;
    }
    return undefined;
};

const wireChargeEvidenceOf = (values: readonly unknown[]): unknown => {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const record = recordOf(values[index]);
        if (record !== null && record.charge !== undefined) return record.charge;
    }
    return undefined;
};

// {§provider-finish-reason} The unified classification is the finish reason; the raw vendor
// value is evidence beside it. One upstream semantic folded into `other` stays distinct: an exact
// `insufficient_system_resource` is a resource interruption ({§provider-interrupted-attempt}).
const finishReasonOf = (unified: string | undefined, raw: string | undefined): ProviderAttemptFinishReason => {
    if (raw === "insufficient_system_resource") return "resource_interrupted";
    switch (unified) {
        case "stop": return "stop";
        case "length": return "length";
        case "tool-calls": return "tool_calls";
        case "content-filter": return "content_filter";
        case "error": return "error";
        default: return null;
    }
};

const recordOf = (value: unknown): Record<string, unknown> | null => isRecord(value) ? value : null;

const metadataOf = (values: readonly unknown[]): Record<string, unknown> => {
    const metadata: Record<string, unknown> = {};
    for (const value of values) {
        const record = recordOf(value);
        if (record === null) continue;
        for (const [key, item] of Object.entries(record)) {
            if (key !== "choices" && key !== "usage" && key !== "charge") metadata[key] = item;
        }
    }
    return metadata;
};

export type AiSdkTransportRequest = {
    url: string;
    model: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    messages: ChatMessage[];
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    streaming: boolean;
    captureRawBody: boolean;
    observeReasoning?: ProviderReasoningObserver;
    observeText?: (delta: string) => void;
};

// {§provider-wire-emission} — what the wire carried, every channel, kept on every response.
type WireEmission = {
    // Raw chunks seen (one for an unstreamed body).
    readonly chunks: number;
    // Chunks whose choice carried no field at all beyond a role: output the wire billed but never showed.
    readonly emptyChunks: number;
    // Every delta or message field seen with a non-null value, with the number of chunks carrying it.
    readonly fields: Record<string, number>;
    // Verbatim text of every string field except content and the reasoning fields, which the record keeps already.
    readonly channels: Record<string, string>;
    // Tool calls merged by index, arguments concatenated as streamed.
    readonly toolCalls: ReadonlyArray<{ index: number; id?: string; type?: string; name?: string; arguments: string }>;
    readonly finishReasons: readonly string[];
    readonly unmappedChunks?: readonly unknown[];
};

export type AiSdkTransportResponse = {
    model: string;
    content: string;
    reasoning: string;
    reasoningProjected: boolean;
    wire: WireEmission;
    finishReason: ProviderAttemptFinishReason;
    rawFinishReason?: string;
    usage?: ProviderUsage;
    usageRefusal?: UsageRefusal;
    metadata: Record<string, unknown>;
    logprobs: TokenLogprob[];
    chargeEvidence: ProviderChargeEvidence;
    rawBody?: unknown;
    warnings: readonly CallWarning[];
};

// Native factories bind the physical request's fetch without shared mutable state.
export type LanguageModelSource = LanguageModel | ((fetch: typeof globalThis.fetch) => LanguageModel);

type AiSdkModelRequest = Omit<AiSdkTransportRequest, "url" | "model" | "body"> & {
    languageModel: LanguageModelSource;
    providerOptions?: Record<string, Record<string, JSONValue | undefined>>;
    systemProviderOptions?: Record<string, Record<string, JSONValue | undefined>>;
    temperature?: number;
    topP?: number;
    topK?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    stopSequences?: string[];
    seed?: number;
    maxOutputTokens?: number;
    reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "none" | "provider-default";
};

type StreamFailure = {
    rawBody: readonly unknown[];
    content: string;
    reasoning: string;
    response?: ProviderChargeEvidence["response"];
    error: unknown;
};

const streamFailures = new WeakMap<object, StreamFailure>();
const streamFailureOutput = new WeakSet<object>();

const retainStreamFailureValues = <T extends object>(source: unknown, target: T): T => {
    if (typeof source !== "object" || source === null) return target;
    const evidence = streamFailures.get(source);
    if (evidence !== undefined) streamFailures.set(target, evidence);
    if (streamFailureOutput.has(source)) streamFailureOutput.add(target);
    return target;
};

// {§provider-cancellation-evidence} (#971) — evidence is keyed by the failure object, so the object
// must be this request's own. A caller's abort reason is shared by every request on that signal (the
// SDK rejects each with the reason itself), so it is wrapped per request before anything is keyed on it.
const preserveStreamFailure = (
    error: unknown,
    evidence: Omit<StreamFailure, "error">,
    outputObserved: boolean,
    signal?: AbortSignal,
): object => {
    const shared = signal !== undefined && signal.aborted && error === signal.reason;
    const failure = typeof error === "object" && error !== null && !shared
        ? error
        : new Error(shared ? "Provider stream cancelled" : "Provider stream failed", { cause: error });
    streamFailures.set(failure, { ...evidence, error });
    if (outputObserved) streamFailureOutput.add(failure);
    return failure;
};

export const transportFailureOutputObserved = (error: unknown): boolean => {
    const seen = new Set<unknown>();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        if (streamFailureOutput.has(current)) return true;
        seen.add(current);
        current = (current as { cause?: unknown }).cause;
    }
    return false;
};

export const normalizeRetryAttemptError = (error: unknown): unknown => {
    if (!APICallError.isInstance(error)) {
        // Node's Undici stream reader reports a peer-aborted HTTP/2 body as this
        // raw TypeError after headers have arrived. Normalize it at the attempt
        // boundary so the owned scheduler sees the same retryability that the
        // public ProviderError contract would otherwise assign too late.
        if (error instanceof TypeError && error.message.trim().toLowerCase() === "terminated") {
            return retainStreamFailureValues(error, new APICallError({
                message: error.message,
                url: "model:generation",
                requestBodyValues: {},
                cause: error,
                isRetryable: false,
            }));
        }
        return error;
    }
    const directed = retryDirective(error.statusCode, error.responseHeaders ?? {});
    // {§provider-connectivity} (#479): without an explicit directive the only
    // transport-retryable failures are the provider-directed waits — a 429, or
    // any status carrying Retry-After; those live in headers the engine never
    // sees. Every other failure — a bare 408/409/5xx, a network error, and the
    // 2xx invalid-response #446 once promoted — surfaces at once;
    // {§provider-recovery} owns re-issue.
    const policy = directed
        ?? (error.statusCode === 429 || retryAfterPresent(error.responseHeaders ?? {}));
    if (policy === error.isRetryable) return error;
    return retainStreamFailureValues(error, new APICallError({
        message: error.message,
        url: error.url,
        requestBodyValues: error.requestBodyValues,
        statusCode: error.statusCode,
        responseHeaders: error.responseHeaders,
        responseBody: error.responseBody,
        cause: error,
        isRetryable: policy,
        data: error.data,
    }));
};

const toLanguageModelUsage = (
    usage: LanguageModelV4Usage | undefined,
): LanguageModelUsage | undefined => {
    if (usage === undefined) return undefined;
    const inputTotal = usage.inputTokens.total;
    const outputTotal = usage.outputTokens.total;
    return {
        inputTokens: inputTotal,
        outputTokens: outputTotal,
        totalTokens: inputTotal !== undefined && outputTotal !== undefined
            ? inputTotal + outputTotal
            : undefined,
        inputTokenDetails: {
            noCacheTokens: usage.inputTokens.noCache,
            cacheReadTokens: usage.inputTokens.cacheRead,
            cacheWriteTokens: usage.inputTokens.cacheWrite,
        },
        outputTokenDetails: {
            textTokens: usage.outputTokens.text,
            reasoningTokens: usage.outputTokens.reasoning,
        },
    };
};

const executeModel = async (
    request: AiSdkModelRequest,
): Promise<AiSdkTransportResponse> => {
    try {
        return await executeModelOnce(request);
    } catch (cause) {
        if (request.signal?.aborted) {
            throw retainStreamFailureValues(cause, new Error("Provider call cancelled", { cause: request.signal.reason }));
        }
        throw normalizeRetryAttemptError(cause);
    }
};

const executeModelOnce = async (
    request: AiSdkModelRequest,
): Promise<AiSdkTransportResponse> => {
    const {
        languageModel,
        providerOptions,
        systemProviderOptions,
        temperature,
        topP,
        topK,
        presencePenalty,
        frequencyPenalty,
        stopSequences,
        seed,
        maxOutputTokens,
        reasoning,
    } = request;
    const resolvedModel = typeof languageModel === "function"
        ? languageModel(request.fetch ?? outboundFetch)
        : languageModel;
    const firstNonSystem = request.messages.findIndex((message) => message.role !== "system");
    const instructionCount = firstNonSystem === -1 ? request.messages.length : firstNonSystem;
    if (request.messages.slice(instructionCount).some((message) => message.role === "system")) {
        throw new Error("provider messages: system instructions must precede user and assistant messages");
    }
    const instructions: LanguageModelPromptMessage[] = request.messages.slice(0, instructionCount).map(({ content }, index) => ({
        role: "system" as const,
        content: chatMessageText({ content }),
        providerOptions: systemProviderOptions !== undefined && index === instructionCount - 1
            ? systemProviderOptions
            : undefined,
    }));
    // {§provider-input-modalities} — user and assistant messages in the SDK's own shape: a user message
    // may be parts (text beside native files distinguished by media type); every other role is text.
    const conversation: LanguageModelPromptMessage[] = request.messages.slice(instructionCount).map((message): LanguageModelPromptMessage => {
        if (message.role === "user") {
            return {
                role: "user",
                content: typeof message.content === "string"
                    ? [{ type: "text", text: message.content }]
                    : message.content.map((part) => part.type === "text"
                        ? { type: "text" as const, text: part.text }
                        : { type: "file" as const, data: { type: "data" as const, data: part.data }, mediaType: part.mediaType }),
                providerOptions: undefined,
            };
        }
        return {
            role: "assistant",
            content: [{ type: "text", text: chatMessageText(message) }],
            providerOptions: undefined,
        };
    });
    const prompt: LanguageModelPromptMessage[] = [
        ...instructions,
        ...(conversation.length > 0
            ? conversation
            : [{ role: "user" as const, content: [{ type: "text" as const, text: "" }], providerOptions: undefined }]),
    ];
    // {§provider-native-tool-calls} — requests pass toolChoice: { type: "none" } ({§provider-native-tools-disabled}),
    // and raw wire tool_calls plus finishReason are preserved on the response without aborting the completed exchange.
    const callOptions: LanguageModelCallOptions = {
        prompt,
        toolChoice: { type: "none" },
        tools: undefined,
        abortSignal: request.signal,
        headers: request.headers,
        ...(temperature === undefined ? {} : { temperature }),
        ...(topP === undefined ? {} : { topP }),
        ...(topK === undefined ? {} : { topK }),
        ...(presencePenalty === undefined ? {} : { presencePenalty }),
        ...(frequencyPenalty === undefined ? {} : { frequencyPenalty }),
        ...(stopSequences === undefined ? {} : { stopSequences }),
        ...(seed === undefined ? {} : { seed }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(providerOptions === undefined ? {} : { providerOptions }),
    };

    if (!request.streaming) {
        const generated = await resolvedModel.doGenerate(callOptions);
        const contentParts = generated.content.filter((part) => part.type !== "tool-call");
        const text = contentParts
            .filter((part): part is Extract<LanguageModelContentPart, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("");
        const sdkReasoning = contentParts
            .filter((part): part is Extract<LanguageModelContentPart, { type: "reasoning" }> => part.type === "reasoning")
            .map((part) => part.text)
            .join("");
        const rawBody = generated.response?.body;
        const values = rawBody === undefined ? [] : [rawBody];
        const evidence = extractEvidence(values);
        const accountingUsage = wireUsageEvidenceOf(values);
        const reasoningText = evidence.reasoning || sdkReasoning || "";
        const rawFinishReason = generated.finishReason.raw;
        const sdkUsage = toLanguageModelUsage(generated.usage);
        return {
            model: generated.response?.modelId ?? resolvedModel.modelId,
            content: text,
            reasoning: reasoningText,
            reasoningProjected: evidence.reasoningProjected,
            wire: wireEmissionOf(values),
            finishReason: finishReasonOf(generated.finishReason.unified, rawFinishReason),
            ...(rawFinishReason === undefined ? {} : { rawFinishReason }),
            ...settledUsage(values, sdkUsage),
            metadata: metadataOf(values),
            logprobs: evidence.logprobs,
            chargeEvidence: {
                ...(wireChargeEvidenceOf(values) === undefined
                    ? {}
                    : { charge: wireChargeEvidenceOf(values) }),
                ...(accountingUsage === undefined ? {} : { usage: accountingUsage }),
                ...(generated.providerMetadata === undefined
                    ? {}
                    : { providerMetadata: generated.providerMetadata }),
                response: {
                    ...(generated.response?.id === undefined ? {} : { id: generated.response.id }),
                    ...(generated.response?.headers === undefined
                        ? {}
                        : { headers: generated.response.headers }),
                },
            },
            ...(request.captureRawBody ? { rawBody } : {}),
            warnings: generated.warnings ?? [],
        };
    }

    const rawChunks: unknown[] = [];
    let streamError: unknown;
    let outputObserved = false;
    let partialContent = "";
    let partialReasoning = "";
    let partialResponse: ProviderChargeEvidence["response"] | undefined;
    try {
        const streamed = await resolvedModel.doStream(callOptions);
        if (streamed.response?.headers !== undefined) {
            partialResponse = { headers: streamed.response.headers };
        }
        let responseId: string | undefined;
        let responseModelId: string | undefined;
        let finishReason: LanguageModelFinishReason = { unified: "other", raw: undefined };
        let v4Usage: LanguageModelV4Usage | undefined;
        let providerMetadata: Record<string, Record<string, JSONValue>> | undefined;
        const warnings: CallWarning[] = [];

        for await (const part of streamed.stream) {
            if (part.type === "stream-start" && part.warnings !== undefined) {
                warnings.push(...part.warnings);
            }
            if (part.type === "raw") {
                rawChunks.push(part.rawValue);
            }
            if (part.type === "response-metadata") {
                if (part.id !== undefined) responseId ??= part.id;
                if (part.modelId !== undefined) responseModelId ??= part.modelId;
                partialResponse = {
                    ...(responseId === undefined ? {} : { id: responseId }),
                    ...(streamed.response?.headers === undefined ? {} : { headers: streamed.response.headers }),
                };
            }
            if (part.type === "text-delta") {
                const delta = part.delta;
                if (delta.length > 0) {
                    outputObserved = true;
                    partialContent += delta;
                    request.observeText?.(delta);
                }
            }
            if (part.type === "reasoning-delta") {
                const delta = part.delta;
                if (delta.length > 0) {
                    outputObserved = true;
                    partialReasoning += delta;
                    request.observeReasoning?.(delta);
                }
            }
            if (part.type === "error") streamError ??= part.error;
            if (part.type === "finish") {
                finishReason = part.finishReason;
                v4Usage = part.usage;
                if (part.providerMetadata !== undefined) providerMetadata = part.providerMetadata;
                partialResponse = {
                    ...(responseId === undefined ? {} : { id: responseId }),
                    ...(streamed.response?.headers === undefined ? {} : { headers: streamed.response.headers }),
                };
            }
        }
        if (streamError !== undefined) throw streamError;
        request.signal?.throwIfAborted();
        const evidence = extractEvidence(rawChunks);
        const accountingUsage = wireUsageEvidenceOf(rawChunks);
        const reasoningText = evidence.reasoning || partialReasoning || "";
        const rawFinishReason = finishReason.raw;
        const unifiedFinishReason = finishReason.unified;
        const sdkUsage = toLanguageModelUsage(v4Usage);
        const finalId = responseId ?? (typeof metadataOf(rawChunks).id === "string" ? String(metadataOf(rawChunks).id) : undefined);
        const finalModelId = responseModelId
            ?? (typeof metadataOf(rawChunks).model === "string" ? String(metadataOf(rawChunks).model) : undefined)
            ?? resolvedModel.modelId;
        return {
            model: finalModelId,
            content: partialContent,
            reasoning: reasoningText,
            reasoningProjected: evidence.reasoningProjected,
            wire: wireEmissionOf(rawChunks),
            finishReason: finishReasonOf(unifiedFinishReason, rawFinishReason),
            ...(rawFinishReason === undefined ? {} : { rawFinishReason }),
            ...settledUsage(rawChunks, sdkUsage),
            metadata: metadataOf(rawChunks),
            logprobs: evidence.logprobs,
            chargeEvidence: {
                ...(wireChargeEvidenceOf(rawChunks) === undefined
                    ? {}
                    : { charge: wireChargeEvidenceOf(rawChunks) }),
                ...(accountingUsage === undefined ? {} : { usage: accountingUsage }),
                ...(providerMetadata === undefined ? {} : { providerMetadata }),
                response: {
                    ...(finalId === undefined ? {} : { id: finalId }),
                    ...(streamed.response?.headers === undefined ? {} : { headers: streamed.response.headers }),
                },
            },
            ...(request.captureRawBody ? { rawBody: rawChunks } : {}),
            warnings,
        };
    } catch (error) {
        throw preserveStreamFailure(error, { rawBody: rawChunks, content: partialContent, reasoning: partialReasoning, response: partialResponse }, outputObserved, request.signal);
    }
};

export const executeAiSdkModel = executeModel;

export type OpenAICompatibleProviderSettings = {
    name?: string;
    baseURL?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
    includeUsage?: boolean;
    includeTopK?: boolean;
    namespace?: string;
    transformRequestBody?: (body: Record<string, unknown>) => Record<string, unknown>;
};

export type OpenAICompatibleProvider = ((modelId: string, modelSettings?: Record<string, unknown>) => LanguageModel) & {
    languageModel: (modelId: string, modelSettings?: Record<string, unknown>) => LanguageModel;
    chat: (modelId: string, modelSettings?: Record<string, unknown>) => LanguageModel;
};

const serializeCompatibleMessages = (
    prompt: readonly LanguageModelPromptMessage[],
    namespace: string,
    endpointUrl: string,
): unknown[] => {
    const serialized: unknown[] = [];
    for (const message of prompt) {
        if (message.role === "system") {
            const nsOpts = isRecord(message.providerOptions?.[namespace]) ? message.providerOptions[namespace] : undefined;
            const orOpts = isRecord(message.providerOptions?.openrouter) ? message.providerOptions.openrouter : undefined;
            const compatOpts = isRecord(message.providerOptions?.openaiCompatible) ? message.providerOptions.openaiCompatible : undefined;
            const cacheControl = nsOpts?.cacheControl ?? orOpts?.cacheControl ?? compatOpts?.cacheControl;
            if (isRecord(cacheControl)) {
                serialized.push({
                    role: "system",
                    content: [{
                        type: "text",
                        text: message.content,
                        cache_control: cacheControl,
                    }],
                });
            } else {
                serialized.push({
                    role: "system",
                    content: message.content,
                });
            }
            continue;
        }
        if (message.role === "assistant") {
            const text = message.content
                .filter((part): part is Extract<typeof message.content[number], { type: "text" }> => part.type === "text")
                .map((part) => part.text)
                .join("");
            serialized.push({
                role: "assistant",
                content: text,
            });
            continue;
        }
        if (message.content.length === 1 && message.content[0]?.type === "text") {
            serialized.push({
                role: "user",
                content: message.content[0].text,
            });
            continue;
        }
        const parts: unknown[] = [];
        for (const part of message.content) {
            if (part.type === "text") {
                parts.push({ type: "text", text: part.text });
                continue;
            }
            const rawBytes = part.data instanceof Uint8Array
                ? part.data
                : isRecord(part.data) && part.data.data instanceof Uint8Array
                    ? part.data.data
                    : undefined;
            const base64 = rawBytes !== undefined
                ? encodeBytesBase64(rawBytes)
                : typeof part.data === "string"
                    ? part.data
                    : isRecord(part.data) && typeof part.data.data === "string"
                        ? part.data.data
                        : "";
            if (part.mediaType.startsWith("image/")) {
                parts.push({
                    type: "image_url",
                    image_url: { url: `data:${part.mediaType};base64,${base64}` },
                });
                continue;
            }
            if (part.mediaType === "audio/wav" || part.mediaType === "audio/x-wav") {
                parts.push({
                    type: "input_audio",
                    input_audio: { data: base64, format: "wav" },
                });
                continue;
            }
            if (part.mediaType === "audio/mpeg" || part.mediaType === "audio/mp3") {
                parts.push({
                    type: "input_audio",
                    input_audio: { data: base64, format: "mp3" },
                });
                continue;
            }
            throw new APICallError({
                message: `Unsupported file media type for OpenAI-compatible chat completions: ${part.mediaType}`,
                url: endpointUrl,
                requestBodyValues: {},
                statusCode: 400,
                isRetryable: false,
            });
        }
        serialized.push({
            role: "user",
            content: parts,
        });
    }
    return serialized;
};

const applyCompatiblePayloadOptions = (
    payload: Record<string, unknown>,
    callOptions: LanguageModelCallOptions,
    settings: OpenAICompatibleProviderSettings,
    modelId: string,
    streaming: boolean,
    endpointUrl: string,
    modelSettings?: Record<string, unknown>,
): void => {
    const namespace = settings.namespace ?? settings.name ?? "openai-compatible";
    delete payload.store;
    delete payload.max_completion_tokens;
    payload.model = modelId;
    payload.messages = serializeCompatibleMessages(callOptions.prompt, namespace, endpointUrl);
    if (callOptions.maxOutputTokens !== undefined) payload.max_tokens = callOptions.maxOutputTokens;
    else delete payload.max_tokens;
    if (callOptions.temperature !== undefined) payload.temperature = callOptions.temperature;
    else delete payload.temperature;
    if (callOptions.topP !== undefined) payload.top_p = callOptions.topP;
    if (settings.includeTopK !== false && callOptions.topK !== undefined) payload.top_k = callOptions.topK;
    if (callOptions.presencePenalty !== undefined) payload.presence_penalty = callOptions.presencePenalty;
    if (callOptions.frequencyPenalty !== undefined) payload.frequency_penalty = callOptions.frequencyPenalty;
    if (callOptions.stopSequences !== undefined) payload.stop = callOptions.stopSequences;
    if (callOptions.seed !== undefined) payload.seed = callOptions.seed;
    if (callOptions.reasoning !== undefined
        && callOptions.reasoning !== "none"
        && callOptions.reasoning !== "provider-default") {
        payload.reasoning_effort = callOptions.reasoning;
    } else {
        delete payload.reasoning_effort;
    }

    if (modelSettings !== undefined) {
        for (const [key, value] of Object.entries(modelSettings)) {
            if (key !== "errorStructure" && value !== undefined) {
                payload[key] = value;
            }
        }
    }

    const nsOptions = isRecord(callOptions.providerOptions?.[namespace])
        ? callOptions.providerOptions[namespace]
        : undefined;
    const compatOptions = namespace !== "openaiCompatible" && isRecord(callOptions.providerOptions?.openaiCompatible)
        ? callOptions.providerOptions.openaiCompatible
        : undefined;
    for (const opts of [compatOptions, nsOptions]) {
        if (opts === undefined) continue;
        for (const [key, value] of Object.entries(opts)) {
            if (value === undefined) continue;
            if (key === "promptCacheKey") {
                payload.prompt_cache_key = value;
                continue;
            }
            if (key === "serviceTier") {
                payload.service_tier = value;
                continue;
            }
            if (key === "reasoningEffort") {
                payload.reasoning_effort = value;
                continue;
            }
            if (key === "logprobs") {
                if (typeof value === "number") {
                    payload.logprobs = true;
                    payload.top_logprobs = value;
                } else if (value === true) {
                    payload.logprobs = true;
                    payload.top_logprobs = 0;
                } else if (value === false) {
                    payload.logprobs = false;
                }
                continue;
            }
            if (key === "topLogprobs") {
                payload.top_logprobs = value;
                continue;
            }
            if (key === "user") {
                payload.user = value;
                continue;
            }
            payload[key] = value;
        }
    }

    if (streaming) {
        payload.stream = true;
        if (settings.includeUsage !== false) {
            payload.stream_options = { include_usage: true };
        }
    } else {
        delete payload.stream;
        delete payload.stream_options;
    }

    if (settings.transformRequestBody !== undefined) {
        const transformed = settings.transformRequestBody({ ...payload });
        for (const key of Object.keys(payload)) delete payload[key];
        Object.assign(payload, transformed);
    } else {
        const cleaned = withoutNativeTools({ ...payload }, "openai");
        for (const key of Object.keys(payload)) delete payload[key];
        Object.assign(payload, cleaned);
    }
    if (!streaming) {
        delete payload.stream;
        delete payload.stream_options;
    }
};

type SseInspectionState = {
    originalChunksQueue: unknown[];
    sseErrorChunks: Array<Record<string, unknown> & { error: unknown }>;
    rawStreamReadError?: unknown;
    lastRawUsage?: Record<string, unknown>;
    lastModelId?: string;
    lastResponseId?: string;
};

const inspectOpenAISseStream = (
    body: ReadableStream<Uint8Array>,
    state: SseInspectionState,
): ReadableStream<Uint8Array> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let closed = false;
    const enqueueBytes = (controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array): void => {
        if (closed) return;
        try {
            controller.enqueue(bytes);
        } catch {
            closed = true;
        }
    };
    const closeStream = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
        if (closed) return;
        closed = true;
        try {
            controller.close();
        } catch {
            // Controller already closed or cancelled.
        }
    };
    const processEventBlock = (block: string, controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
        const lines = block.split(/\r?\n/);
        const dataLines: string[] = [];
        for (const line of lines) {
            if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
            }
        }
        if (dataLines.length === 0) {
            if (block.length > 0) enqueueBytes(controller, encoder.encode(`${block}\n\n`));
            return false;
        }
        const data = dataLines.join("\n").trim();
        if (data === "[DONE]") {
            enqueueBytes(controller, encoder.encode("data: [DONE]\n\n"));
            return false;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch {
            enqueueBytes(controller, encoder.encode(`${block}\n\n`));
            return false;
        }
        if (!isRecord(parsed)) {
            enqueueBytes(controller, encoder.encode(`${block}\n\n`));
            return false;
        }
        if (typeof parsed.id === "string") state.lastResponseId = parsed.id;
        if (typeof parsed.model === "string") state.lastModelId = parsed.model;
        if (isRecord(parsed.usage)) state.lastRawUsage = parsed.usage;
        if (isRecord(parsed.error)) {
            state.sseErrorChunks.push({ ...parsed, error: parsed.error });
            enqueueBytes(controller, encoder.encode("data: [DONE]\n\n"));
            closeStream(controller);
            return true;
        }
        state.originalChunksQueue.push(parsed);
        const clone: Record<string, unknown> = { ...parsed };
        if (Array.isArray(parsed.choices)) {
            clone.choices = parsed.choices.map((choiceValue) => {
                if (!isRecord(choiceValue) || !isRecord(choiceValue.delta)) return choiceValue;
                const delta = { ...choiceValue.delta };
                let combinedReasoning = "";
                let sawReasoning = false;
                for (const field of ["reasoning_content", "reasoning", "thinking"]) {
                    if (typeof delta[field] === "string" && delta[field].length > 0) {
                        sawReasoning = true;
                        combinedReasoning += delta[field];
                    }
                }
                if (sawReasoning) {
                    delta.reasoning_content = combinedReasoning;
                    delete delta.reasoning;
                    delete delta.thinking;
                }
                return { ...choiceValue, delta };
            });
        }
        enqueueBytes(controller, encoder.encode(`data: ${JSON.stringify(clone)}\n\n`));
        return false;
    };

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                while (true) {
                    const boundary = buffer.match(/\r?\n\r?\n/);
                    if (boundary?.index !== undefined) {
                        const block = buffer.slice(0, boundary.index);
                        buffer = buffer.slice(boundary.index + boundary[0].length);
                        if (processEventBlock(block, controller)) return;
                        return;
                    }
                    const { done, value } = await reader.read();
                    if (done) {
                        buffer += decoder.decode();
                        if (buffer.trim().length > 0) {
                            if (processEventBlock(buffer, controller)) return;
                            buffer = "";
                        }
                        closeStream(controller);
                        return;
                    }
                    buffer += decoder.decode(value, { stream: true });
                }
            } catch (error) {
                state.rawStreamReadError = error;
                enqueueBytes(controller, encoder.encode("data: [DONE]\n\n"));
                closeStream(controller);
            }
        },
        async cancel(reason) {
            closed = true;
            await reader.cancel(reason).catch(() => {});
        },
    });
};

const toV4UsageFromPi = (
    piUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number },
    rawUsage: Record<string, unknown> | undefined,
): LanguageModelV4Usage => {
    const promptTokens = typeof rawUsage?.prompt_tokens === "number"
        ? rawUsage.prompt_tokens
        : piUsage.input + piUsage.cacheRead + piUsage.cacheWrite;
    const completionTokens = typeof rawUsage?.completion_tokens === "number"
        ? rawUsage.completion_tokens
        : piUsage.output;
    const promptDetails = isRecord(rawUsage?.prompt_tokens_details) ? rawUsage.prompt_tokens_details : undefined;
    const completionDetails = isRecord(rawUsage?.completion_tokens_details) ? rawUsage.completion_tokens_details : undefined;
    const cachedTokens = typeof promptDetails?.cached_tokens === "number"
        ? promptDetails.cached_tokens
        : typeof promptDetails?.cache_read_tokens === "number"
            ? promptDetails.cache_read_tokens
            : typeof rawUsage?.prompt_cache_hit_tokens === "number"
                ? rawUsage.prompt_cache_hit_tokens
                : undefined;
    const cacheWriteTokens = typeof promptDetails?.cache_write_tokens === "number"
        ? promptDetails.cache_write_tokens
        : typeof rawUsage?.cache_creation_input_tokens === "number"
            ? rawUsage.cache_creation_input_tokens
            : undefined;
    const reasoningTokens = typeof completionDetails?.reasoning_tokens === "number"
        ? completionDetails.reasoning_tokens
        : undefined;
    return {
        inputTokens: {
            total: promptTokens,
            noCache: cachedTokens !== undefined ? promptTokens - cachedTokens - (cacheWriteTokens ?? 0) : piUsage.input,
            cacheRead: cachedTokens ?? piUsage.cacheRead,
            cacheWrite: cacheWriteTokens ?? (piUsage.cacheWrite > 0 ? piUsage.cacheWrite : undefined),
        },
        outputTokens: {
            total: completionTokens,
            text: reasoningTokens !== undefined ? completionTokens - reasoningTokens : completionTokens,
            reasoning: reasoningTokens,
        },
    };
};

export const createOpenAICompatible = (
    settings: OpenAICompatibleProviderSettings,
): OpenAICompatibleProvider => {
    const providerName = settings.name ?? "openai-compatible";
    const resolvedBaseUrl = (settings.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const endpointUrl = `${resolvedBaseUrl}/chat/completions`;
    const underlyingFetch = settings.fetch ?? outboundFetch;

    const makeLanguageModel = (modelId: string, modelSettings?: Record<string, unknown>): LanguageModel => {
        const buildPiModel = (callHeaders?: Record<string, string | undefined>): Model<"openai-completions"> => {
            const mergedHeaders: Record<string, string> = { ...settings.headers };
            if (callHeaders !== undefined) {
                for (const [key, value] of Object.entries(callHeaders)) {
                    if (value !== undefined) mergedHeaders[key] = value;
                }
            }
            return {
                id: modelId,
                name: modelId,
                api: "openai-completions",
                provider: providerName,
                baseUrl: resolvedBaseUrl,
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
                headers: mergedHeaders,
                compat: {
                    supportsStore: false,
                    supportsDeveloperRole: false,
                    supportsReasoningEffort: true,
                    supportsUsageInStreaming: settings.includeUsage !== false,
                    maxTokensField: "max_tokens",
                    supportsStrictMode: false,
                },
            };
        };

        const dummyContext = normalizeContext({
            messages: [{ role: "user", content: "", timestamp: 0 }],
        });

        const stripStreamFieldsFromInit = (init: RequestInit | undefined): RequestInit | undefined => {
            if (init === undefined || typeof init.body !== "string") return init;
            try {
                const parsed: unknown = JSON.parse(init.body);
                if (!isRecord(parsed)) return init;
                delete parsed.stream;
                delete parsed.stream_options;
                return { ...init, body: JSON.stringify(parsed) };
            } catch {
                return init;
            }
        };

        const awaitFetchWithAbort = async (
            fetchPromise: Promise<Response>,
            signal: AbortSignal | null | undefined,
        ): Promise<Response> => {
            if (signal === undefined || signal === null) return fetchPromise;
            if (signal.aborted) throw signal.reason ?? new Error("Request was aborted");
            return new Promise<Response>((resolve, reject) => {
                const onAbort = (): void => {
                    reject(signal.reason ?? new Error("Request was aborted"));
                };
                signal.addEventListener("abort", onAbort, { once: true });
                fetchPromise.then(
                    (res) => {
                        signal.removeEventListener("abort", onAbort);
                        resolve(res);
                    },
                    (err) => {
                        signal.removeEventListener("abort", onAbort);
                        reject(err);
                    },
                );
            });
        };

        return {
            specificationVersion: "v4",
            provider: `${providerName}.chat`,
            modelId,
            supportedUrls: {},
            async doGenerate(callOptions: LanguageModelCallOptions): Promise<LanguageModelGenerateResult> {
                callOptions.abortSignal?.throwIfAborted();
                let capturedRequestBody: unknown = {};
                let rawResponseBody: Record<string, unknown> | undefined;
                let responseHeadersRecord: Record<string, string> | undefined;
                let pendingFetch: Promise<Response> | undefined;
                let settleHeaders!: () => void;
                let failHeaders!: (error: unknown) => void;
                const headersReady = new Promise<void>((resolve, reject) => {
                    settleHeaders = resolve;
                    failHeaders = reject;
                });

                const customFetch: typeof globalThis.fetch = async (input, init) => {
                    try {
                        const rawPromise = underlyingFetch(input, stripStreamFieldsFromInit(init));
                        rawPromise.catch(() => {});
                        pendingFetch = rawPromise;
                        const response = await awaitFetchWithAbort(rawPromise, callOptions.abortSignal);
                        responseHeadersRecord = headersToRecord(response.headers);
                        if (!response.ok) {
                            const text = await response.text().catch(() => "");
                            const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                            const apiError = new APICallError({
                                message,
                                url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
                                requestBodyValues: capturedRequestBody,
                                statusCode: response.status,
                                responseHeaders: responseHeadersRecord,
                                responseBody: text,
                                isRetryable: isResponseRetryable(response.status, response.headers),
                                data,
                            });
                            failHeaders(apiError);
                            throw apiError;
                        }
                        let text: string;
                        try {
                            text = await response.text();
                        } catch (cause) {
                            const apiError = new APICallError({
                                message: "Failed to process successful response",
                                url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
                                requestBodyValues: capturedRequestBody,
                                statusCode: response.status,
                                responseHeaders: responseHeadersRecord,
                                cause,
                                isRetryable: isResponseRetryable(response.status, response.headers),
                            });
                            failHeaders(apiError);
                            throw apiError;
                        }
                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(text);
                        } catch (cause) {
                            const apiError = new APICallError({
                                message: "Failed to process successful response",
                                url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
                                requestBodyValues: capturedRequestBody,
                                statusCode: response.status,
                                responseHeaders: responseHeadersRecord,
                                responseBody: text,
                                cause: new JSONParseError({ text, cause }),
                                isRetryable: isResponseRetryable(response.status, response.headers),
                            });
                            failHeaders(apiError);
                            throw apiError;
                        }
                        if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
                            const received = isRecord(parsed) ? typeof parsed.choices : typeof parsed;
                            const apiError = new APICallError({
                                message: "Failed to process successful response",
                                url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
                                requestBodyValues: capturedRequestBody,
                                statusCode: response.status,
                                responseHeaders: responseHeadersRecord,
                                responseBody: text,
                                cause: new TypeValidationError({
                                    value: parsed,
                                    cause: new Error(`Invalid input: expected array, received ${received}`),
                                }),
                                isRetryable: isResponseRetryable(response.status, response.headers),
                            });
                            failHeaders(apiError);
                            throw apiError;
                        }
                        rawResponseBody = parsed;
                        settleHeaders();
                        const syntheticChoices = parsed.choices.map((choiceValue, index) => {
                            if (!isRecord(choiceValue)) return { index, delta: {}, finish_reason: "stop" };
                            const message = isRecord(choiceValue.message) ? choiceValue.message : isRecord(choiceValue.delta) ? choiceValue.delta : {};
                            const delta: Record<string, unknown> = { ...message };
                            let combinedReasoning = "";
                            let sawReasoning = false;
                            for (const field of ["reasoning_content", "reasoning", "thinking"]) {
                                if (typeof delta[field] === "string" && delta[field].length > 0) {
                                    sawReasoning = true;
                                    combinedReasoning += delta[field];
                                }
                            }
                            if (sawReasoning) {
                                delta.reasoning_content = combinedReasoning;
                                delete delta.reasoning;
                                delete delta.thinking;
                            }
                            if (Array.isArray(delta.tool_calls)) {
                                delta.tool_calls = delta.tool_calls.map((tc, tcIndex) =>
                                    isRecord(tc) ? { index: typeof tc.index === "number" ? tc.index : tcIndex, ...tc } : tc);
                            }
                            return {
                                index: typeof choiceValue.index === "number" ? choiceValue.index : index,
                                delta,
                                finish_reason: typeof choiceValue.finish_reason === "string" ? choiceValue.finish_reason : "stop",
                            };
                        });
                        const syntheticChunk = {
                            id: typeof parsed.id === "string" ? parsed.id : "chatcmpl",
                            object: "chat.completion.chunk",
                            created: typeof parsed.created === "number" ? parsed.created : 0,
                            model: typeof parsed.model === "string" ? parsed.model : modelId,
                            choices: syntheticChoices,
                            ...(isRecord(parsed.usage) ? { usage: parsed.usage } : {}),
                        };
                        return new Response(`data: ${JSON.stringify(syntheticChunk)}\n\ndata: [DONE]\n\n`, {
                            status: 200,
                            headers: { "content-type": "text/event-stream" },
                        });
                    } catch (error) {
                        failHeaders(error);
                        throw error;
                    }
                };

                let payloadError: unknown;
                const piModel = buildPiModel(callOptions.headers);
                const piStream = streamOpenAICompletions(piModel, dummyContext, {
                    apiKey: settings.apiKey ?? "plurnk-no-key",
                    signal: callOptions.abortSignal,
                    maxRetries: 0,
                    fetch: customFetch,
                    onPayload: (params) => {
                        if (!isRecord(params)) return;
                        try {
                            applyCompatiblePayloadOptions(params, callOptions, settings, modelId, false, endpointUrl, modelSettings);
                            capturedRequestBody = { ...params };
                            params.stream = true;
                        } catch (error) {
                            payloadError = error;
                            throw error;
                        }
                    },
                });
                const resultPromise = piStream.result();
                try {
                    await Promise.race([
                        headersReady,
                        resultPromise.then(() => {
                            if (payloadError !== undefined) throw payloadError;
                        }),
                    ]);
                    if (payloadError !== undefined) throw payloadError;
                } catch (error) {
                    if (pendingFetch !== undefined) {
                        await pendingFetch.catch(() => {});
                    }
                    throw error;
                }
                const assistantMsg = await resultPromise;
                const choice0 = Array.isArray(rawResponseBody?.choices) && isRecord(rawResponseBody.choices[0])
                    ? rawResponseBody.choices[0]
                    : undefined;
                const rawFinish = typeof choice0?.finish_reason === "string"
                    ? choice0.finish_reason
                    : assistantMsg.rawStopReason;
                const content: LanguageModelContentPart[] = [];
                for (const block of assistantMsg.content) {
                    if (block.type === "thinking") content.push({ type: "reasoning", text: block.thinking });
                    else if (block.type === "text") content.push({ type: "text", text: block.text });
                    else if (block.type === "toolCall") {
                        content.push({
                            type: "tool-call",
                            toolCallId: block.id,
                            toolName: block.name,
                            input: JSON.stringify(block.arguments ?? {}),
                        });
                    }
                }
                const rawUsage = isRecord(rawResponseBody?.usage) ? rawResponseBody.usage : undefined;
                return {
                    content,
                    finishReason: {
                        unified: toUnifiedFinishReason(rawFinish),
                        raw: rawFinish,
                    },
                    usage: toV4UsageFromPi(assistantMsg.usage, rawUsage),
                    response: {
                        id: typeof rawResponseBody?.id === "string" ? rawResponseBody.id : undefined,
                        modelId: typeof rawResponseBody?.model === "string" ? rawResponseBody.model : modelId,
                        headers: responseHeadersRecord,
                        body: rawResponseBody,
                    },
                    warnings: [],
                };
            },
            async doStream(callOptions: LanguageModelCallOptions): Promise<LanguageModelStreamResult> {
                callOptions.abortSignal?.throwIfAborted();
                let capturedRequestBody: unknown = {};
                let responseHeadersRecord: Record<string, string> | undefined;
                let pendingFetch: Promise<Response> | undefined;
                let settleHeaders!: () => void;
                let failHeaders!: (error: unknown) => void;
                const headersReady = new Promise<void>((resolve, reject) => {
                    settleHeaders = resolve;
                    failHeaders = reject;
                });
                const sseState: SseInspectionState = {
                    originalChunksQueue: [],
                    sseErrorChunks: [],
                };

                const customFetch: typeof globalThis.fetch = async (input, init) => {
                    try {
                        const rawPromise = underlyingFetch(input, init);
                        rawPromise.catch(() => {});
                        pendingFetch = rawPromise;
                        const response = await awaitFetchWithAbort(rawPromise, callOptions.abortSignal);
                        responseHeadersRecord = headersToRecord(response.headers);
                        if (!response.ok) {
                            const text = await response.text().catch(() => "");
                            const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                            const apiError = new APICallError({
                                message,
                                url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
                                requestBodyValues: capturedRequestBody,
                                statusCode: response.status,
                                responseHeaders: responseHeadersRecord,
                                responseBody: text,
                                isRetryable: isResponseRetryable(response.status, response.headers),
                                data,
                            });
                            failHeaders(apiError);
                            throw apiError;
                        }
                        settleHeaders();
                        const headers = new Headers(response.headers);
                        headers.set("content-type", "text/event-stream");
                        const inspectedBody = response.body === null
                            ? null
                            : inspectOpenAISseStream(response.body, sseState);
                        return new Response(inspectedBody, {
                            status: response.status,
                            statusText: response.statusText,
                            headers,
                        });
                    } catch (error) {
                        failHeaders(error);
                        throw error;
                    }
                };

                let streamController!: ReadableStreamDefaultController<LanguageModelStreamPart>;
                let streamClosed = false;
                const safeEnqueue = (part: LanguageModelStreamPart): void => {
                    if (streamClosed) return;
                    streamController.enqueue(part);
                };
                const safeClose = (): void => {
                    if (streamClosed) return;
                    streamClosed = true;
                    streamController.close();
                };

                const stream = new ReadableStream<LanguageModelStreamPart>({
                    start(controller) {
                        streamController = controller;
                        controller.enqueue({ type: "stream-start", warnings: [] });
                    },
                });

                let payloadError: unknown;
                let emittedMetadata = false;
                const piModel = buildPiModel(callOptions.headers);
                const piStream = streamOpenAICompletions(piModel, dummyContext, {
                    apiKey: settings.apiKey ?? "plurnk-no-key",
                    signal: callOptions.abortSignal,
                    maxRetries: 0,
                    fetch: customFetch,
                    onPayload: (params) => {
                        if (!isRecord(params)) return;
                        try {
                            applyCompatiblePayloadOptions(params, callOptions, settings, modelId, true, endpointUrl, modelSettings);
                            capturedRequestBody = { ...params };
                        } catch (error) {
                            payloadError = error;
                            throw error;
                        }
                    },
                    onProviderStreamEvent: (chunk) => {
                        const rawChunk = sseState.originalChunksQueue.shift() ?? chunk;
                        safeEnqueue({ type: "raw", rawValue: rawChunk });
                        if (!emittedMetadata && isRecord(rawChunk)) {
                            const id = typeof rawChunk.id === "string" ? rawChunk.id : undefined;
                            const chunkModel = typeof rawChunk.model === "string" ? rawChunk.model : undefined;
                            if (id !== undefined || chunkModel !== undefined) {
                                emittedMetadata = true;
                                safeEnqueue({
                                    type: "response-metadata",
                                    ...(id === undefined ? {} : { id }),
                                    ...(chunkModel === undefined ? {} : { modelId: chunkModel }),
                                });
                            }
                        }
                    },
                });

                const originalPush = piStream.push.bind(piStream);
                piStream.push = (event: AssistantMessageEvent): void => {
                    if (event.type === "thinking_delta") {
                        safeEnqueue({ type: "reasoning-delta", id: `reasoning-${event.contentIndex}`, delta: event.delta });
                    } else if (event.type === "text_delta") {
                        safeEnqueue({ type: "text-delta", id: `text-${event.contentIndex}`, delta: event.delta });
                    } else if (event.type === "done" || event.type === "error") {
                        while (sseState.originalChunksQueue.length > 0) {
                            safeEnqueue({ type: "raw", rawValue: sseState.originalChunksQueue.shift() });
                        }
                        if (sseState.sseErrorChunks.length > 0) {
                            for (const errChunk of sseState.sseErrorChunks) {
                                safeEnqueue({ type: "raw", rawValue: errChunk });
                                safeEnqueue({ type: "error", error: errChunk.error });
                            }
                            safeClose();
                            originalPush(event);
                            return;
                        }
                        if (sseState.rawStreamReadError !== undefined) {
                            safeEnqueue({ type: "error", error: sseState.rawStreamReadError });
                            safeClose();
                            originalPush(event);
                            return;
                        }
                        if (callOptions.abortSignal?.aborted) {
                            safeEnqueue({
                                type: "error",
                                error: callOptions.abortSignal.reason ?? new Error("Request was aborted"),
                            });
                            safeClose();
                            originalPush(event);
                            return;
                        }
                        if (event.type === "done") {
                            const rawFinish = event.message.rawStopReason;
                            safeEnqueue({
                                type: "finish",
                                finishReason: {
                                    unified: toUnifiedFinishReason(rawFinish),
                                    raw: rawFinish,
                                },
                                usage: toV4UsageFromPi(event.message.usage, sseState.lastRawUsage),
                            });
                            safeClose();
                        } else {
                            const rawFinish = event.error.rawStopReason;
                            const msg = event.error.errorMessage ?? "";
                            if (rawFinish !== undefined && msg === `Provider finish_reason: ${rawFinish}`) {
                                safeEnqueue({
                                    type: "finish",
                                    finishReason: {
                                        unified: toUnifiedFinishReason(rawFinish),
                                        raw: rawFinish,
                                    },
                                    usage: toV4UsageFromPi(event.error.usage, sseState.lastRawUsage),
                                });
                                safeClose();
                            } else if (msg === "Stream ended without finish_reason") {
                                safeEnqueue({
                                    type: "error",
                                    error: new Error("Response stream ended without a finish reason."),
                                });
                                safeClose();
                            } else {
                                safeEnqueue({
                                    type: "error",
                                    error: new Error(msg || "Provider stream error"),
                                });
                                safeClose();
                            }
                        }
                    }
                    originalPush(event);
                };

                const resultPromise = piStream.result();
                try {
                    await Promise.race([
                        headersReady,
                        resultPromise.then(() => {
                            if (payloadError !== undefined) throw payloadError;
                        }),
                    ]);
                    if (payloadError !== undefined) throw payloadError;
                } catch (error) {
                    if (pendingFetch !== undefined) {
                        await pendingFetch.catch(() => {});
                    }
                    throw error;
                }
                return {
                    stream,
                    response: {
                        ...(responseHeadersRecord === undefined ? {} : { headers: responseHeadersRecord }),
                    },
                };
            },
        };
    };

    return Object.assign(
        (modelId: string, modelSettings?: Record<string, unknown>) => makeLanguageModel(modelId, modelSettings),
        {
            languageModel: makeLanguageModel,
            chat: makeLanguageModel,
        },
    );
};

const SDK_OWNED_BODY_KEYS = ["model", "messages", "stream", "stream_options", "tools", "tool_choice", "functions", "function_call", "parallel_tool_calls"] as const;

export const executeOpenAICompatible = async (
    request: AiSdkTransportRequest,
): Promise<AiSdkTransportResponse> => {
    for (const key of SDK_OWNED_BODY_KEYS) {
        if (Object.hasOwn(request.body, key)) {
            throw new TypeError(`OpenAI-compatible request extensions may not override SDK-owned field ${JSON.stringify(key)}`);
        }
    }
    const provider = createOpenAICompatible({
        name: "plurnk",
        baseURL: baseUrl(request.url),
        headers: request.headers,
        fetch: request.fetch,
        includeUsage: true,
        transformRequestBody: (sdkBody) => withoutNativeTools({
            ...sdkBody,
            ...request.body,
            stream: sdkBody.stream,
            ...(sdkBody.stream_options !== undefined
                ? { stream_options: sdkBody.stream_options }
                : {}),
        }, "openai"),
    });
    const model = provider.languageModel(request.model);
    return executeModel({
        languageModel: model,
        headers: {},
        messages: request.messages,
        signal: request.signal,
        streaming: request.streaming,
        captureRawBody: request.captureRawBody,
        ...(request.observeReasoning === undefined ? {} : { observeReasoning: request.observeReasoning }),
        ...(request.observeText === undefined ? {} : { observeText: request.observeText }),
    });
};

const responseBodyValues = (error: APICallError): readonly unknown[] => {
    if (error.responseBody === undefined || error.responseBody.length === 0) return [];
    try {
        return [JSON.parse(error.responseBody)];
    } catch {
        return [];
    }
};

export type AiSdkTransportFailureEvidence = {
    readonly usage?: ProviderUsage;
    readonly usageRefusal?: UsageRefusal;
    readonly chargeEvidence: ProviderChargeEvidence;
    readonly status?: number;
    readonly content: string;
    readonly reasoning: string;
    readonly rawBody?: unknown;
    readonly error: unknown;
    readonly transportError?: unknown;
};

const failureRecord = (error: unknown, seen = new Set<unknown>()): unknown => {
    if (!(error instanceof Error)) return error;
    if (seen.has(error)) return { name: error.name, message: "Circular error cause" };
    seen.add(error);
    return {
        name: error.name,
        message: error.message,
        ...("code" in error ? { code: error.code } : {}),
        ...("data" in error ? { data: error.data } : {}),
        ...(error.cause === undefined ? {} : { cause: failureRecord(error.cause, seen) }),
    };
};

export const transportFailureEvidence = (
    error: unknown,
): AiSdkTransportFailureEvidence => {
    const partial = typeof error === "object" && error !== null ? streamFailures.get(error) : undefined;
    const apiError = APICallError.isInstance(error) ? error : undefined;
    const values = [...(partial?.rawBody ?? (apiError === undefined ? [] : responseBodyValues(apiError))), error];
    const emission = extractEvidence(values);
    const settled = settledUsage(values, undefined);
    const usageEvidence = wireUsageEvidenceOf(values);
    const charge = wireChargeEvidenceOf(values);
    const responseId = metadataOf(values).id;
    const wireStatus = values
        .map(recordOf)
        .find((record) => Number.isInteger(record?.status))?.status;
    const apiStatus = apiError?.statusCode;
    const httpStatus = (value: unknown): number | undefined => isSafeInteger(value) && value >= 100 && value <= 599 ? value : undefined;
    const status = httpStatus(apiStatus) ?? httpStatus(wireStatus);
    return {
        content: emission.content || partial?.content || "",
        reasoning: emission.reasoning || partial?.reasoning || "",
        ...(partial !== undefined ? { rawBody: partial.rawBody }
            : apiError?.responseBody === undefined ? {} : { rawBody: apiError.responseBody }),
        error: failureRecord(error),
        ...(partial === undefined || partial.error === error ? {} : { transportError: failureRecord(partial.error) }),
        ...settled,
        chargeEvidence: {
            ...(charge === undefined ? {} : { charge }),
            ...(usageEvidence === undefined ? {} : { usage: usageEvidence }),
            response: {
                ...(typeof responseId === "string" ? { id: responseId } : {}),
                ...(apiError?.responseHeaders === undefined ? {} : { headers: apiError.responseHeaders }),
                ...partial?.response,
            },
        },
        ...(status === undefined ? {} : { status }),
    };
};

const RETAINED_FIELDS = new Set(["content", "reasoning_content", "reasoning", "thinking", "role"]);

// {§provider-wire-emission} — the emission as the wire carried it: field counts, chunks that
// carried nothing, merged tool calls, and the verbatim text of every channel the normalized record
// does not already hold. A blank emission is then readable instead of guessed at.
const wireEmissionOf = (values: readonly unknown[]): WireEmission => {
    let chunks = 0;
    let emptyChunks = 0;
    const fields: Record<string, number> = {};
    const channels: Record<string, string> = {};
    const toolCalls = new Map<number, { index: number; id?: string; type?: string; name?: string; arguments: string }>();
    const finishReasons = new Set<string>();
    const unmappedChunks: unknown[] = [];
    for (const value of values) {
        const record = recordOf(value);
        chunks += 1;
        if (record === null || !Array.isArray(record.choices)) {
            unmappedChunks.push(value);
            continue;
        }
        const choices = record.choices;
        let carried = false;
        for (const item of choices) {
            const choice = recordOf(item);
            if (choice === null) continue;
            if (typeof choice.finish_reason === "string") finishReasons.add(choice.finish_reason);
            const message = recordOf(choice.delta) ?? recordOf(choice.message);
            if (message === null) continue;
            for (const [key, field] of Object.entries(message)) {
                if (field === null || field === undefined || key === "role") continue;
                if (typeof field === "string" && field.length === 0) continue;
                carried = true;
                fields[key] = (fields[key] ?? 0) + 1;
                if (key === "tool_calls" && Array.isArray(field)) {
                    for (const [position, callValue] of field.entries()) {
                        const call = recordOf(callValue);
                        if (call === null) continue;
                        const index = typeof call.index === "number" ? call.index : position;
                        const merged = toolCalls.get(index) ?? { index, arguments: "" };
                        if (typeof call.id === "string") merged.id = call.id;
                        if (typeof call.type === "string") merged.type = call.type;
                        const fn = recordOf(call.function);
                        if (typeof fn?.name === "string") merged.name = fn.name;
                        if (typeof fn?.arguments === "string") merged.arguments += fn.arguments;
                        toolCalls.set(index, merged);
                    }
                    continue;
                }
                if (RETAINED_FIELDS.has(key)) continue;
                channels[key] = (channels[key] ?? "") + (typeof field === "string" ? field : JSON.stringify(field));
            }
        }
        if (choices.length > 0 && !carried) emptyChunks += 1;
    }
    return {
        chunks,
        emptyChunks,
        fields,
        channels,
        toolCalls: [...toolCalls.values()].toSorted((a, b) => a.index - b.index),
        finishReasons: [...finishReasons],
        ...(unmappedChunks.length === 0 ? {} : { unmappedChunks }),
    };
};

const extractEvidence = (values: unknown[]): {
    logprobs: TokenLogprob[];
    content: string;
    reasoning: string;
    reasoningProjected: boolean;
} => {
    const logprobs: TokenLogprob[] = [];
    let content = "";
    let reasoning = "";
    let reasoningProjected = false;
    for (const value of values) {
        const choices = recordOf(value)?.choices;
        if (!Array.isArray(choices)) continue;
        const choice = recordOf(choices[0]);
        if (choice === null) continue;
        const logprobRecord = recordOf(choice.logprobs);
        const entries = logprobRecord?.content;
        if (Array.isArray(entries)) {
            for (const entryValue of entries) {
                const entry = recordOf(entryValue);
                if (typeof entry?.token !== "string" || typeof entry.logprob !== "number") continue;
                const top = Array.isArray(entry.top_logprobs)
                    ? entry.top_logprobs.flatMap((candidate) => {
                        const item = recordOf(candidate);
                        return typeof item?.token === "string" && typeof item.logprob === "number"
                            ? [{ token: item.token, logprob: item.logprob }]
                            : [];
                    })
                    : undefined;
                logprobs.push(top === undefined
                    ? { token: entry.token, logprob: entry.logprob }
                    : { token: entry.token, logprob: entry.logprob, top });
            }
        }
        const delta = recordOf(choice.delta);
        const message = delta ?? recordOf(choice.message) ?? {};
        if (typeof message.content === "string") content += message.content;
        for (const key of ["reasoning_content", "reasoning", "thinking"]) {
            if (typeof message[key] === "string") {
                reasoningProjected = true;
                reasoning += message[key];
            }
        }
    }
    return {
        logprobs,
        content,
        reasoning,
        reasoningProjected,
    };
};
