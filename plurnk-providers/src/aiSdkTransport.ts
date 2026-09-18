import { chatMessageText } from "./types.ts";
import { createOpenAICompatible, type ProviderErrorStructure } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, streamText, type CallWarning, type JSONValue, type LanguageModel, type LanguageModelUsage, type ModelMessage } from "ai";
import { z } from "zod";
import type { ChatMessage, ProviderAttemptFinishReason, ProviderChargeEvidence, ProviderReasoningObserver, ProviderUsage, TokenLogprob } from "./types.ts";
import { normalizeUsage, type RawUsage } from "./usage.ts";
import { emitWarningOnce } from "./warnings.ts";
import { ProviderTimeoutError, providerTimeoutOf } from "./errors.ts";

const errorSchema = z.object({
    error: z.object({
        message: z.string(),
        type: z.string().nullish(),
        param: z.unknown().nullish(),
        code: z.union([z.string(), z.number()]).nullish(),
    }).passthrough(),
}).passthrough();

const retryDirective = (
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
const retryAfterPresent = (
    headers: Headers | Readonly<Record<string, string>>,
): boolean => {
    const raw = headers instanceof Headers
        ? headers.get("retry-after")
        : Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
    return raw !== undefined && raw !== null && raw.trim() !== "";
};

const errorStructure: ProviderErrorStructure<z.infer<typeof errorSchema>> = {
    errorSchema,
    errorToMessage: ({ error }) => error.message,
    isRetryable(response) {
        // {§provider-connectivity} (#479): only a provider-directed wait — 429,
        // a Retry-After, or an explicit X-Should-Retry — earns a transport retry.
        return retryDirective(response.status, response.headers)
            ?? (response.status === 429 || retryAfterPresent(response.headers));
    },
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
): ProviderUsage | undefined => {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const usage = recordOf(values[index])?.usage;
        if (usage !== null && typeof usage === "object") {
            return normalizeUsage(usage as RawUsage);
        }
    }
    return undefined;
};

// {§provider-usage-refusal} — the provider's bookkeeping is not the exchange. When the reported
// counters cannot be normalized (a reasoning detail exceeding its output aggregate, a total that
// contradicts its parts), the response stands, usage is unknown (never invented, clamped, or zero),
// and the counters as reported ride beside the refusal so forensics can see what the wire said.
export type UsageRefusal = { readonly reason: string; readonly usage: unknown };

const settledUsage = (
    values: readonly unknown[],
    sdkUsage: LanguageModelUsage | undefined,
): { usage?: ProviderUsage; usageRefusal?: UsageRefusal } => {
    try {
        const usage = wireUsageOf(values) ?? (sdkUsage === undefined ? undefined : usageOf(sdkUsage));
        return usage === undefined ? {} : { usage };
    } catch (cause) {
        if (!(cause instanceof TypeError)) throw cause;
        return { usageRefusal: { reason: cause.message, usage: wireUsageEvidenceOf(values) ?? sdkUsage } };
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

const finishReasonOf = (reason: string | undefined): ProviderAttemptFinishReason => {
    switch (reason?.toLowerCase()) {
        case "stop":
        case "completed":
        case "end_turn":
        case "stop_sequence":
        case "eos_token":
            return "stop";
        case "length":
        case "max_tokens":
        case "model_length":
        case "max_completion_tokens":
            return "length";
        case "tool_calls":
        case "tool_use":
            return "tool_calls";
        case "content_filter":
        case "safety":
        case "recitation":
            return "content_filter";
        case "insufficient_system_resource":
            return "resource_interrupted";
        default:
            if (reason !== undefined && reason.length > 0) {
                emitWarningOnce(
                    `unrecognized finish_reason "${reason}"; treated as no-signal (finishReason=null). If it denotes a token-cap hit, core's length-cap detection will miss it.`,
                    "PLURNK_FINISH_REASON_UNKNOWN",
                );
            }
            return null;
    }
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object"
        ? value as Record<string, unknown>
        : null;

// {§google-thought-response} — Gemini behind an OpenAI-compatible endpoint returns its readable
// thought summary as ordinary `content` wrapped `<thought>…</thought>` and flagged
// `extra_content.google.thought`. Whole, the flagged message holds wrapper and answer; streamed,
// the flagged deltas hold `<thought>` and the thought, and the first unflagged delta opens with
// `</thought>` before the answer.
const googleThoughtFlagged = (message: Record<string, unknown> | null): boolean =>
    recordOf(recordOf(message?.extra_content)?.google)?.thought === true;

const THOUGHT_OPEN = "<thought>";
const THOUGHT_CLOSE = "</thought>";
const splitGoogleThought = (content: string): { thought: string; answer: string } | null => {
    if (!content.startsWith(THOUGHT_OPEN)) return null;
    const close = content.indexOf(THOUGHT_CLOSE);
    if (close === -1) return null;
    return { thought: content.slice(THOUGHT_OPEN.length, close), answer: content.slice(close + THOUGHT_CLOSE.length) };
};

const unwrapThoughtDelta = (text: string): string => {
    const opened = text.startsWith(THOUGHT_OPEN) ? text.slice(THOUGHT_OPEN.length) : text;
    return opened.endsWith(THOUGHT_CLOSE) ? opened.slice(0, -THOUGHT_CLOSE.length) : opened;
};

const rawChunkThought = (value: unknown): boolean => {
    const choices = recordOf(value)?.choices;
    return Array.isArray(choices) && googleThoughtFlagged(recordOf(recordOf(choices[0])?.delta));
};

const wholeResponseThought = (values: readonly unknown[]): boolean => values.some((value) => {
    const choices = recordOf(value)?.choices;
    return Array.isArray(choices) && googleThoughtFlagged(recordOf(recordOf(choices[0])?.message));
});

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
    fetchTimeoutMs: number;
    firstContentTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
    streaming: boolean;
    captureRawBody: boolean;
    observeReasoning?: ProviderReasoningObserver;
    observeText?: (delta: string) => void;
};

export type AiSdkTransportResponse = {
    model: string;
    content: string;
    reasoning: string;
    reasoningProjected: boolean;
    finishReason: ProviderAttemptFinishReason;
    rawFinishReason?: string;
    usage?: ProviderUsage;
    usageRefusal?: UsageRefusal;
    metadata: Record<string, unknown>;
    reasoningEncrypted: Array<{
        id: string | null;
        subtype: string;
        encrypted: Array<{ data: string; format: string | null }>;
    }>;
    logprobs: TokenLogprob[];
    chargeEvidence: ProviderChargeEvidence;
    rawBody?: unknown;
    warnings: readonly CallWarning[];
};

type AiSdkModelRequest = Omit<AiSdkTransportRequest, "url" | "model" | "body" | "fetch"> & {
    languageModel: LanguageModel;
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

const transportTimeout = (
    cause: unknown,
    request: AiSdkModelRequest,
): ProviderTimeoutError | null => {
    const owned = providerTimeoutOf(cause);
    if (owned !== null) return owned;

    const seen = new Set<unknown>();
    let current = cause;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        if ((current as { name?: string }).name === "TimeoutError") break;
        seen.add(current);
        current = (current as { cause?: unknown }).cause;
    }
    if (typeof current !== "object" || current === null) return null;

    const message = String((current as { message?: unknown }).message ?? "");
    if (/first chunk timeout/i.test(message)) {
        return new ProviderTimeoutError("first_content", request.firstContentTimeoutMs ?? 0, cause);
    }
    if (/chunk timeout/i.test(message)) {
        return new ProviderTimeoutError("stream_idle", request.streamIdleTimeoutMs ?? 0, cause);
    }
    return new ProviderTimeoutError("attempt", request.fetchTimeoutMs, cause);
};

const streamFailureValues = new WeakMap<object, readonly unknown[]>();
const streamFailureOutput = new WeakSet<object>();

const retainStreamFailureValues = <T extends object>(source: object, target: T): T => {
    const values = streamFailureValues.get(source);
    if (values !== undefined) streamFailureValues.set(target, values);
    if (streamFailureOutput.has(source)) streamFailureOutput.add(target);
    return target;
};

const preserveStreamFailure = (
    error: unknown,
    rawChunks: readonly unknown[],
    outputObserved: boolean,
): void => {
    if (typeof error !== "object" || error === null) return;
    streamFailureValues.set(error, [...rawChunks, error]);
    if (outputObserved) streamFailureOutput.add(error);
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
        // Attempt, first-content, and stream-idle deadlines surface on the first
        // failure ({§provider-connectivity}, #479): the engine's {§provider-recovery}
        // owns re-issue with backoff and park; the stall is reported, never swallowed.
        if (error instanceof ProviderTimeoutError && error.phase !== "operation") {
            return retainStreamFailureValues(error, new APICallError({
                message: error.message,
                url: "model:generation",
                requestBodyValues: {},
                cause: error,
                isRetryable: false,
            }));
        }
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

const executeModel = async (
    request: AiSdkModelRequest,
): Promise<AiSdkTransportResponse> => {
    try {
        return await executeModelOnce(request);
    } catch (cause) {
        if (request.signal?.aborted) throw request.signal.reason;
        const timeout = transportTimeout(cause, request);
        if (timeout === null) throw normalizeRetryAttemptError(cause);
        throw new APICallError({
            message: timeout.message,
            url: "model:generation",
            requestBodyValues: {},
            cause: timeout,
            isRetryable: false,
        });
    }
};

const executeModelOnce = async (
    request: AiSdkModelRequest,
): Promise<AiSdkTransportResponse> => {
    const {
        languageModel: model,
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
    const settings = {
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
    const firstNonSystem = request.messages.findIndex((message) => message.role !== "system");
    const instructionCount = firstNonSystem === -1 ? request.messages.length : firstNonSystem;
    if (request.messages.slice(instructionCount).some((message) => message.role === "system")) {
        throw new Error("provider messages: system instructions must precede conversational messages");
    }
    const instructions = request.messages.slice(0, instructionCount).map(({ content }, index) => ({
        role: "system" as const,
        content: chatMessageText({ content }),
        ...(systemProviderOptions !== undefined && index === instructionCount - 1
            ? { providerOptions: systemProviderOptions }
            : {}),
    }));
    // {§provider-input-modalities} — conversational messages in the SDK's own shape: a user message
    // may be parts (text beside native files distinguished by media type); every other role is text.
    const messages: ModelMessage[] = request.messages.slice(instructionCount).map((message): ModelMessage => {
        if (message.role === "user") {
            return typeof message.content === "string"
                ? { role: "user", content: message.content }
                : {
                    role: "user",
                    content: message.content.map((part) => part.type === "text"
                        ? { type: "text" as const, text: part.text }
                        : { type: "file" as const, data: part.data, mediaType: part.mediaType }),
                };
        }
        return message.role === "assistant"
            ? { role: "assistant", content: chatMessageText(message) }
            : { role: "system", content: chatMessageText(message) };
    });
    // {§provider-connectivity} — a streamed attempt's deadline holds only until semantic content
    // flows; after that, stream-idle catches a stall and the operation deadline bounds the whole.
    // A healthy stream still producing (long reasoning) is never cut off and its tokens wasted.
    const attemptDeadline = request.streaming && request.fetchTimeoutMs > 0 ? new AbortController() : null;
    const attemptTimer = attemptDeadline === null ? null : setTimeout(
        () => attemptDeadline.abort(new ProviderTimeoutError("attempt", request.fetchTimeoutMs)),
        request.fetchTimeoutMs,
    );
    const liftAttemptDeadline = (): void => { if (attemptTimer !== null) clearTimeout(attemptTimer); };
    const abortSignal = attemptDeadline === null
        ? request.signal
        : request.signal === undefined ? attemptDeadline.signal : AbortSignal.any([request.signal, attemptDeadline.signal]);
    const common = {
        model,
        ...(instructions.length === 0 ? {} : { instructions }),
        messages: messages.length > 0
            ? messages
            : [{ role: "user" as const, content: "" }],
        // AiSdkProvider owns retries so every physical request is independently
        // observed and accounted. The SDK transport executes exactly once.
        maxRetries: 0,
        abortSignal,
        headers: request.headers,
        timeout: {
            ...(request.fetchTimeoutMs > 0 && !request.streaming ? { totalMs: request.fetchTimeoutMs } : {}),
            ...(request.streaming
                && request.firstContentTimeoutMs !== undefined
                && request.firstContentTimeoutMs > 0
                ? { firstChunkMs: request.firstContentTimeoutMs }
                : {}),
            ...(request.streaming
                && request.streamIdleTimeoutMs !== undefined
                && request.streamIdleTimeoutMs > 0
                ? { chunkMs: request.streamIdleTimeoutMs }
                : {}),
        },
        ...settings,
    } as const;

    if (!request.streaming) {
        const result = await generateText({
            ...common,
            include: { responseBody: true },
        });
        const rawBody = result.response.body;
        const values = [rawBody];
        const evidence = extractEvidence(values);
        const accountingUsage = wireUsageEvidenceOf(values);
        const reasoningText = evidence.reasoning || result.reasoningText || "";
        const rawFinishReason = result.rawFinishReason;
        const thought = wholeResponseThought(values) ? splitGoogleThought(result.text) : null;
        return {
            model: result.response.modelId,
            content: thought === null ? result.text : thought.answer,
            reasoning: reasoningText,
            reasoningProjected: evidence.reasoningProjected,
            finishReason: finishReasonOf(rawFinishReason),
            ...(rawFinishReason === undefined ? {} : { rawFinishReason }),
            ...settledUsage(values, result.usage),
            metadata: metadataOf(values),
            reasoningEncrypted: evidence.reasoningEncrypted,
            logprobs: evidence.logprobs,
            chargeEvidence: {
                ...(wireChargeEvidenceOf(values) === undefined
                    ? {}
                    : { charge: wireChargeEvidenceOf(values) }),
                ...(accountingUsage === undefined ? {} : { usage: accountingUsage }),
                ...(result.providerMetadata === undefined
                    ? {}
                    : { providerMetadata: result.providerMetadata }),
                response: {
                    id: result.response.id,
                    ...(result.response.headers === undefined
                        ? {}
                        : { headers: result.response.headers }),
                },
            },
            ...(request.captureRawBody ? { rawBody } : {}),
            warnings: result.warnings ?? [],
        };
    }

    const result = streamText({
        ...common,
        includeRawChunks: true,
        onError: () => {},
    });
    const rawChunks: unknown[] = [];
    let streamError: unknown;
    let outputObserved = false;
    // The SDK enqueues each raw chunk before the deltas it yields, so the latest raw chunk's
    // thought flag classifies the text deltas that follow ({§google-thought-response}).
    let thoughtChunk = false;
    let thoughtSeen = false;
    let answer = "";
    try {
        for await (const part of result.fullStream) {
            if (part.type === "raw") {
                rawChunks.push(part.rawValue);
                thoughtChunk = rawChunkThought(part.rawValue);
            }
            if (part.type === "text-delta" && part.text.length > 0) {
                outputObserved = true;
                liftAttemptDeadline();
                if (thoughtChunk) {
                    thoughtSeen = true;
                    const thought = unwrapThoughtDelta(part.text);
                    if (thought.length > 0) request.observeReasoning?.(thought);
                } else {
                    const text = thoughtSeen && answer.length === 0 && part.text.startsWith(THOUGHT_CLOSE)
                        ? part.text.slice(THOUGHT_CLOSE.length)
                        : part.text;
                    answer += text;
                    if (text.length > 0) request.observeText?.(text);
                }
            }
            if (part.type === "reasoning-delta" && part.text.length > 0) {
                outputObserved = true;
                liftAttemptDeadline();
                request.observeReasoning?.(part.text);
            }
            if (part.type === "error") streamError ??= part.error;
        }
    } catch (error) {
        preserveStreamFailure(error, rawChunks, outputObserved);
        throw error;
    } finally {
        liftAttemptDeadline();
    }
    if (streamError !== undefined) {
        preserveStreamFailure(streamError, rawChunks, outputObserved);
        throw streamError;
    }
    const evidence = extractEvidence(rawChunks);
    const accountingUsage = wireUsageEvidenceOf(rawChunks);
    const content = thoughtSeen ? answer : await result.text;
    const reasoningText = evidence.reasoning || (await result.reasoningText) || "";
    const rawFinishReason = await result.rawFinishReason;
    const [response, providerMetadata, warnings] = await Promise.all([
        result.response,
        result.providerMetadata,
        result.warnings,
    ]);
    return {
        model: response.modelId,
        content,
        reasoning: reasoningText,
        reasoningProjected: evidence.reasoningProjected,
        finishReason: finishReasonOf(rawFinishReason),
        ...(rawFinishReason === undefined ? {} : { rawFinishReason }),
        ...settledUsage(rawChunks, await result.usage),
        metadata: metadataOf(rawChunks),
        reasoningEncrypted: evidence.reasoningEncrypted,
        logprobs: evidence.logprobs,
        chargeEvidence: {
            ...(wireChargeEvidenceOf(rawChunks) === undefined
                ? {}
                : { charge: wireChargeEvidenceOf(rawChunks) }),
            ...(accountingUsage === undefined ? {} : { usage: accountingUsage }),
            ...(providerMetadata === undefined ? {} : { providerMetadata }),
            response: {
                id: response.id,
                ...(response.headers === undefined ? {} : { headers: response.headers }),
            },
        },
        ...(request.captureRawBody ? { rawBody: rawChunks } : {}),
        warnings: warnings ?? [],
    };
};

export const executeAiSdkModel = executeModel;

const SDK_OWNED_BODY_KEYS = ["model", "messages", "stream", "stream_options"] as const;

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
        transformRequestBody: (sdkBody) => ({
            ...sdkBody,
            ...request.body,
            stream: sdkBody.stream,
            ...(sdkBody.stream_options !== undefined
                ? { stream_options: sdkBody.stream_options }
                : {}),
        }),
    });
    const model = provider.languageModel(request.model, { errorStructure });
    return executeModel({
        languageModel: model,
        headers: {},
        messages: request.messages,
        signal: request.signal,
        fetchTimeoutMs: request.fetchTimeoutMs,
        firstContentTimeoutMs: request.firstContentTimeoutMs,
        streamIdleTimeoutMs: request.streamIdleTimeoutMs,
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
};

export const transportFailureEvidence = (
    error: unknown,
): AiSdkTransportFailureEvidence => {
    const values = typeof error === "object" && error !== null
        ? streamFailureValues.get(error) ?? (APICallError.isInstance(error) ? responseBodyValues(error) : [])
        : [];
    const settled = settledUsage(values, undefined);
    const usageEvidence = wireUsageEvidenceOf(values);
    const charge = wireChargeEvidenceOf(values);
    const wireStatus = values
        .map(recordOf)
        .find((record) => Number.isInteger(record?.status))?.status;
    const apiStatus = APICallError.isInstance(error) ? error.statusCode : undefined;
    const status = Number.isInteger(apiStatus) && (apiStatus as number) >= 100 && (apiStatus as number) <= 599
        ? apiStatus as number
        : Number.isInteger(wireStatus) && (wireStatus as number) >= 100 && (wireStatus as number) <= 599
            ? wireStatus as number
            : undefined;
    return {
        ...settled,
        chargeEvidence: {
            ...(charge === undefined ? {} : { charge }),
            ...(usageEvidence === undefined ? {} : { usage: usageEvidence }),
            response: {},
        },
        ...(status === undefined ? {} : { status }),
    };
};

const extractEvidence = (values: unknown[]): {
    reasoningEncrypted: AiSdkTransportResponse["reasoningEncrypted"];
    logprobs: TokenLogprob[];
    reasoning: string;
    reasoningProjected: boolean;
} => {
    const encrypted = new Map<string, AiSdkTransportResponse["reasoningEncrypted"][number]>();
    const logprobs: TokenLogprob[] = [];
    let reasoning = "";
    let reasoningProjected = false;
    let anonymous = 0;
    for (const value of values) {
        const choices = recordOf(value)?.choices;
        if (!Array.isArray(choices)) continue;
        const choice = recordOf(choices[0]);
        if (choice === null) continue;
        const logprobRecord = recordOf(choice.logprobs);
        const entries = logprobRecord?.content;
        if (Array.isArray(entries)) {
            for (const value of entries) {
                const entry = recordOf(value);
                if (typeof entry?.token !== "string" || typeof entry.logprob !== "number") continue;
                const top = Array.isArray(entry.top_logprobs)
                    ? entry.top_logprobs.flatMap((value) => {
                        const item = recordOf(value);
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
        for (const key of ["reasoning_content", "reasoning", "thinking"]) { // lexicon-allow: backend wire fields
            if (typeof message[key] === "string") {
                reasoningProjected = true;
                reasoning += message[key];
            }
        }
        if (googleThoughtFlagged(message) && typeof message.content === "string") {
            const thought = delta !== null ? unwrapThoughtDelta(message.content) : splitGoogleThought(message.content)?.thought;
            if (thought !== undefined) {
                reasoningProjected = true;
                reasoning += thought;
            }
        }
        if (!Array.isArray(message.reasoning_details)) continue;
        for (const value of message.reasoning_details) {
            const detail = recordOf(value);
            if (detail?.type !== "reasoning.encrypted" || typeof detail.data !== "string") continue;
            const id = typeof detail.id === "string" ? detail.id : null;
            const key = typeof detail.index === "number"
                ? `index:${detail.index}`
                : id === null ? `anonymous:${anonymous++}` : `id:${id}`;
            const item: AiSdkTransportResponse["reasoningEncrypted"][number] = encrypted.get(key) ?? {
                id,
                // {§provider-encrypted-reasoning} The documented wire location
                // is the assistant message. `id` above still identifies only
                // this provider detail, never a downstream message entity.
                subtype: "message",
                encrypted: [],
            };
            const format = typeof detail.format === "string" ? detail.format : null;
            const prior = item.encrypted.at(-1);
            if (prior !== undefined) {
                prior.data += detail.data;
                if (prior.format === null && format !== null) prior.format = format;
            } else {
                item.encrypted.push({ data: detail.data, format });
            }
            encrypted.set(key, item);
        }
    }
    return {
        reasoningEncrypted: [...encrypted.values()],
        logprobs,
        reasoning,
        reasoningProjected,
    };
};
