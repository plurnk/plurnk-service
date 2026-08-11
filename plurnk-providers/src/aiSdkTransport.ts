import { createOpenAICompatible, type ProviderErrorStructure } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, streamText, type JSONValue, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod/v4";
import type { ChatMessage, ProviderAttemptFinishReason, ProviderChargeEvidence, ProviderUsage, TokenLogprob } from "./types.ts";
import { normalizeUsage, type RawUsage } from "./usage.ts";
import { emitWarningOnce } from "./warnings.ts";

const errorSchema = z.object({
    error: z.object({
        message: z.string(),
        type: z.string().nullish(),
        param: z.unknown().nullish(),
        code: z.union([z.string(), z.number()]).nullish(),
    }).passthrough(),
}).passthrough();

const errorStructure: ProviderErrorStructure<z.infer<typeof errorSchema>> = {
    errorSchema,
    errorToMessage: ({ error }) => error.message,
    isRetryable(response) {
        const directive = response.headers.get("x-should-retry")?.trim().toLowerCase();
        if (directive === "false") return false;
        if (directive === "true") return true;
        if (response.status >= 520 && response.status <= 527) return false;
        return response.status === 408
            || response.status === 409
            || response.status === 429
            || response.status >= 500;
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
    streamIdleTimeoutMs?: number;
    streaming: boolean;
    captureRawBody: boolean;
};

export type AiSdkTransportResponse = {
    model: string;
    content: string;
    reasoning: string;
    reasoningProjected: boolean;
    finishReason: ProviderAttemptFinishReason;
    rawFinishReason?: string;
    usage?: ProviderUsage;
    metadata: Record<string, unknown>;
    reasoningEncrypted: Array<{
        id: string | null;
        subtype: string;
        encrypted: Array<{ data: string; format: string | null }>;
    }>;
    logprobs: TokenLogprob[];
    chargeEvidence: ProviderChargeEvidence;
    rawBody?: unknown;
};

export type AiSdkModelRequest = Omit<AiSdkTransportRequest, "url" | "model" | "body" | "fetch"> & {
    languageModel: LanguageModel;
    providerOptions?: Record<string, Record<string, JSONValue | undefined>>;
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

const isStreamIdleTimeout = (cause: unknown): cause is Error | DOMException =>
    typeof cause === "object"
    && cause !== null
    && (cause as { name?: string }).name === "TimeoutError"
    && /chunk timeout/i.test(String((cause as { message?: unknown }).message ?? ""));

const streamFailureValues = new WeakMap<object, readonly unknown[]>();

const executeModel = async (
    request: AiSdkModelRequest,
): Promise<AiSdkTransportResponse> => {
    const timeoutSignal = AbortSignal.timeout(request.fetchTimeoutMs);
    const operationSignal = request.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([request.signal, timeoutSignal]);
    try {
        return await executeModelOnce({ ...request, signal: operationSignal });
    } catch (cause) {
        if (operationSignal.aborted) throw operationSignal.reason;
        if (!isStreamIdleTimeout(cause)) throw cause;
        throw new APICallError({
            message: cause.message,
            url: "model:generation",
            requestBodyValues: {},
            cause,
            isRetryable: true,
        });
    }
};

const executeModelOnce = async (
    request: AiSdkModelRequest,
): Promise<AiSdkTransportResponse> => {
    const {
        languageModel: model,
        providerOptions,
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
    const instructions = request.messages.slice(0, instructionCount).map(({ content }) => ({
        role: "system" as const,
        content,
    }));
    const messages = request.messages.slice(instructionCount);
    const common = {
        model,
        ...(instructions.length === 0 ? {} : { instructions }),
        messages: messages.length > 0
            ? messages
            : [{ role: "user" as const, content: "" }],
        // AiSdkProvider owns retries so every physical request is independently
        // observed and accounted. The SDK transport executes exactly once.
        maxRetries: 0,
        abortSignal: request.signal,
        headers: request.headers,
        timeout: {
            totalMs: request.fetchTimeoutMs,
            ...(request.streamIdleTimeoutMs !== undefined && request.streamIdleTimeoutMs > 0
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
        return {
            model: result.response.modelId,
            content: result.text,
            reasoning: reasoningText,
            reasoningProjected: evidence.reasoningProjected,
            finishReason: finishReasonOf(rawFinishReason),
            ...(rawFinishReason === undefined ? {} : { rawFinishReason }),
            usage: wireUsageOf(values) ?? usageOf(result.usage),
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
        };
    }

    const result = streamText({
        ...common,
        includeRawChunks: true,
        onError: () => {},
    });
    const rawChunks: unknown[] = [];
    let streamError: unknown;
    for await (const part of result.fullStream) {
        if (part.type === "raw") rawChunks.push(part.rawValue);
        if (part.type === "error") streamError ??= part.error;
    }
    if (streamError !== undefined) {
        if (typeof streamError === "object" && streamError !== null) {
            streamFailureValues.set(streamError, [...rawChunks, streamError]);
        }
        throw streamError;
    }
    const evidence = extractEvidence(rawChunks);
    const accountingUsage = wireUsageEvidenceOf(rawChunks);
    const content = await result.text;
    const reasoningText = evidence.reasoning || (await result.reasoningText) || "";
    const rawFinishReason = await result.rawFinishReason;
    const [response, providerMetadata] = await Promise.all([
        result.response,
        result.providerMetadata,
    ]);
    return {
        model: response.modelId,
        content,
        reasoning: reasoningText,
        reasoningProjected: evidence.reasoningProjected,
        finishReason: finishReasonOf(rawFinishReason),
        ...(rawFinishReason === undefined ? {} : { rawFinishReason }),
        usage: wireUsageOf(rawChunks) ?? usageOf(await result.usage),
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
    };
};

export const executeAiSdkModel = executeModel;

export const executeOpenAICompatible = async (
    request: AiSdkTransportRequest,
): Promise<AiSdkTransportResponse> => {
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
        streamIdleTimeoutMs: request.streamIdleTimeoutMs,
        streaming: request.streaming,
        captureRawBody: request.captureRawBody,
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
    readonly chargeEvidence: ProviderChargeEvidence;
    readonly status?: number;
};

export const transportFailureEvidence = (
    error: unknown,
): AiSdkTransportFailureEvidence => {
    const values = typeof error === "object" && error !== null
        ? streamFailureValues.get(error) ?? (APICallError.isInstance(error) ? responseBodyValues(error) : [])
        : [];
    const usage = wireUsageOf(values);
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
        ...(usage === undefined ? {} : { usage }),
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
        const message = recordOf(choice.delta) ?? recordOf(choice.message) ?? {};
        for (const key of ["reasoning_content", "reasoning", "thinking"]) { // lexicon-allow: backend wire fields
            if (typeof message[key] === "string") {
                reasoningProjected = true;
                reasoning += message[key];
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
