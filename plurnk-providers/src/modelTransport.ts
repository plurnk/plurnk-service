import {
    normalizeContext,
    type Api,
    type Message,
    type Model,
    type TranscriptContext,
    type Usage,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamBedrockConverseStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as streamGoogleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
import { outboundFetch } from "@plurnk/plurnk-meta";
import { APICallError } from "./errors.ts";
import { withoutNativeTools } from "./native-tools.ts";
import {
    chatMessageText,
    type CallWarning,
    type ChatContentPart,
    type ChatMessage,
    type JSONValue,
    type ProviderAttemptFinishReason,
    type ProviderChargeEvidence,
    type ProviderModel,
    type ProviderModelApi,
    type ProviderReasoningObserver,
    type ProviderRequestCapture,
    type ProviderUsage,
    type TokenLogprob,
} from "./types.ts";
import { normalizeUsage, UsageDetailError, type RawUsage } from "./usage.ts";

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const ZERO_USAGE: Usage = Object.freeze({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const recordOf = (value: unknown): Record<string, unknown> | null => isRecord(value) ? value : null;

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

// {§provider-failure-normalization} (#479): a Retry-After header on any status is the
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

const isResponseRetryable = (
    status: number,
    headers: Headers | Readonly<Record<string, string>>,
): boolean => retryDirective(status, headers)
    ?? (status === 429 || retryAfterPresent(headers));

const headersToRecord = (headers: Headers): Record<string, string> => {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
        record[key] = value;
    });
    return record;
};

const extractErrorMessage = (
    responseText: string,
    statusText: string,
    status: number,
): { message: string; data?: unknown } => {
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

const encodeBytesBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
};

const baseUrl = (completionUrl: string): string => {
    const url = new URL(completionUrl);
    if (!url.pathname.endsWith("/chat/completions")) {
        throw new Error(`OpenAI-compatible URL must end in /chat/completions: ${completionUrl}`);
    }
    url.pathname = url.pathname.slice(0, -"/chat/completions".length);
    return url.toString().replace(/\/$/, "");
};

const CONTENT_FILTER_REASONS = new Set([
    "content_filter", "content-filter", "content_filtered", "guardrail_intervened",
    "sensitive", "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
]);
const ERROR_FINISH_REASONS = new Set(["error", "network_error", "MALFORMED_FUNCTION_CALL"]);

// {§provider-interface} The unified classification is the finish reason; the raw vendor
// value is evidence beside it. One upstream semantic folded into `other` stays distinct: an exact
// `insufficient_system_resource` is a resource interruption ({§provider-failure-normalization}).
const finishReasonOf = (stopReason: string | undefined, raw: string | undefined): ProviderAttemptFinishReason => {
    if (raw === "insufficient_system_resource" || raw === "resource_interrupted") return "resource_interrupted";
    if (raw === "model_context_window_exceeded") return "length";
    if (raw !== undefined && CONTENT_FILTER_REASONS.has(raw)) return "content_filter";
    if (raw !== undefined && ERROR_FINISH_REASONS.has(raw)) return "error";
    switch (stopReason) {
        case "stop": return "stop";
        case "length": return "length";
        case "toolUse":
        case "tool-calls": return "tool_calls";
        case "content-filter": return "content_filter";
        case "error": return raw === undefined ? "error" : null;
        default: return null;
    }
};

type UsageRefusal = { readonly reason: string; readonly usage: unknown };

const piUsageInputHint = (
    piUsage: Usage | undefined,
): Pick<ProviderUsage, "inputTokens" | "inputTokenDetails"> | undefined => {
    if (piUsage === undefined) return undefined;
    const totalInput = piUsage.input + piUsage.cacheRead + piUsage.cacheWrite;
    if (totalInput === 0 && piUsage.output === 0 && piUsage.totalTokens === 0) return undefined;
    return {
        inputTokens: totalInput,
        inputTokenDetails: {
            noCacheTokens: piUsage.input,
            cacheReadTokens: piUsage.cacheRead,
            ...(piUsage.cacheWrite > 0 ? { cacheWriteTokens: piUsage.cacheWrite } : {}),
        },
    };
};

const wireRawUsageOf = (values: readonly unknown[]): RawUsage | undefined => {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const record = recordOf(values[index]);
        if (record === null || record.type === "message_start" || record.type === "message_delta") continue;
        const usage = recordOf(record.usage) ?? recordOf(recordOf(record.response)?.usage);
        if (usage !== null && ("prompt_tokens" in usage || "completion_tokens" in usage || "total_tokens" in usage || "input_tokens" in usage || "output_tokens" in usage)) {
            return usage;
        }
    }
    return undefined;
};

const wireUsageEvidenceOf = (values: readonly unknown[]): unknown => {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const record = recordOf(values[index]);
        if (record === null) continue;
        if (record.usage !== undefined) return record.usage;
        const resp = recordOf(record.response);
        if (resp !== null && resp.usage !== undefined) return resp.usage;
        if (record.usageMetadata !== undefined) return record.usageMetadata;
        const meta = recordOf(record.metadata);
        if (meta !== null && meta.usage !== undefined) return meta.usage;
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

const settledUsage = (
    values: readonly unknown[],
    piUsage: Usage | undefined,
): { usage?: ProviderUsage; usageRefusal?: UsageRefusal } => {
    try {
        const raw = wireRawUsageOf(values);
        const hint = piUsageInputHint(piUsage);
        const usage = raw !== undefined
            ? normalizeUsage(raw, hint)
            : hint !== undefined && piUsage !== undefined
                ? normalizeUsage({
                    prompt_tokens: hint.inputTokens,
                    completion_tokens: piUsage.output,
                    total_tokens: piUsage.totalTokens || (hint.inputTokens ?? 0) + piUsage.output,
                    prompt_cache_miss_tokens: hint.inputTokenDetails?.noCacheTokens,
                    prompt_tokens_details: {
                        cached_tokens: hint.inputTokenDetails?.cacheReadTokens,
                        cache_write_tokens: hint.inputTokenDetails?.cacheWriteTokens,
                    },
                    ...(piUsage.reasoning !== undefined && piUsage.reasoning > 0
                        ? { completion_tokens_details: { reasoning_tokens: piUsage.reasoning } }
                        : {}),
                })
                : undefined;
        return usage === undefined ? {} : { usage };
    } catch (cause) {
        if (!(cause instanceof TypeError)) throw cause;
        return {
            ...(cause instanceof UsageDetailError ? { usage: cause.usage } : {}),
            usageRefusal: { reason: cause.message, usage: wireUsageEvidenceOf(values) ?? piUsage },
        };
    }
};

const metadataOf = (values: readonly unknown[]): Record<string, unknown> => {
    const metadata: Record<string, unknown> = {};
    for (const value of values) {
        const record = recordOf(value);
        if (record === null) continue;
        for (const [key, item] of Object.entries(record)) {
            if (key !== "choices" && key !== "usage" && key !== "charge") metadata[key] = item;
        }
        const sub = recordOf(record.response) ?? recordOf(record.message);
        if (sub !== null) {
            if (typeof sub.id === "string" && metadata.id === undefined) metadata.id = sub.id;
            if (typeof sub.model === "string" && metadata.model === undefined) metadata.model = sub.model;
        }
        if (typeof record.responseId === "string" && metadata.id === undefined) metadata.id = record.responseId;
        if (typeof record.modelVersion === "string" && metadata.model === undefined) metadata.model = record.modelVersion;
    }
    return metadata;
};

const RETAINED_FIELDS = new Set(["content", "reasoning_content", "reasoning", "thinking", "role"]);

export type WireEmission = {
    readonly chunks: number;
    readonly emptyChunks: number;
    readonly fields: Record<string, number>;
    readonly channels: Record<string, string>;
    readonly toolCalls: ReadonlyArray<{ index: number; id?: string; type?: string; name?: string; arguments: string }>;
    readonly finishReasons: readonly string[];
    readonly unmappedChunks?: readonly unknown[];
};

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

const parseLogprobEntry = (entryValue: unknown): TokenLogprob | null => {
    const entry = recordOf(entryValue);
    if (typeof entry?.token !== "string" || typeof entry.logprob !== "number") return null;
    const top = Array.isArray(entry.top_logprobs)
        ? entry.top_logprobs.flatMap((candidate) => {
            const item = recordOf(candidate);
            return typeof item?.token === "string" && typeof item.logprob === "number"
                ? [{ token: item.token, logprob: item.logprob }]
                : [];
        })
        : undefined;
    return top === undefined
        ? { token: entry.token, logprob: entry.logprob }
        : { token: entry.token, logprob: entry.logprob, top };
};

const extractEvidence = (values: readonly unknown[]): {
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
        const record = recordOf(value);
        if (record === null) continue;
        const resp = recordOf(record.response);
        if (resp !== null && Array.isArray(resp.output)) {
            for (const itemValue of resp.output) {
                const item = recordOf(itemValue);
                if (item === null || !Array.isArray(item.content)) continue;
                for (const partValue of item.content) {
                    const part = recordOf(partValue);
                    if (part === null || !Array.isArray(part.logprobs)) continue;
                    for (const lp of part.logprobs) {
                        const parsed = parseLogprobEntry(lp);
                        if (parsed !== null) logprobs.push(parsed);
                    }
                }
            }
        }
        const choices = record.choices;
        if (!Array.isArray(choices)) continue;
        const choice = recordOf(choices[0]);
        if (choice === null) continue;
        const logprobRecord = recordOf(choice.logprobs);
        const entries = logprobRecord?.content;
        if (Array.isArray(entries)) {
            for (const entryValue of entries) {
                const parsed = parseLogprobEntry(entryValue);
                if (parsed !== null) logprobs.push(parsed);
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

export type OpenAICompatibleRequest = {
    url: string;
    model: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    messages: ChatMessage[];
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    captureRawBody: boolean;
    observeReasoning?: ProviderReasoningObserver;
    observeText?: (delta: string) => void;
};

export type ProviderModelRequest = Omit<OpenAICompatibleRequest, "url" | "model" | "body"> & {
    providerModel: ProviderModel;
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
    reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "none" | "provider-default";
    captureRequest?: (request: ProviderRequestCapture) => void;
};

export type ProviderModelResponse = {
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

// {§provider-failure-normalization} (#971) — evidence is keyed by the failure object, so the object
// must be this request's own. A caller's abort reason is shared by every request on that signal, so
// it is wrapped per request before anything is keyed on it.
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

const normalizeRetryAttemptError = (error: unknown): unknown => {
    if (!APICallError.isInstance(error)) {
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

const validateMessageOrder = (messages: readonly ChatMessage[]): number => {
    const firstNonSystem = messages.findIndex((message) => message.role !== "system");
    const instructionCount = firstNonSystem === -1 ? messages.length : firstNonSystem;
    if (messages.slice(instructionCount).some((message) => message.role === "system")) {
        throw new Error("provider messages: system instructions must precede user and assistant messages");
    }
    return instructionCount;
};

const toTranscriptContext = (
    messages: readonly ChatMessage[],
    api: Api,
    provider: string,
    modelId: string,
): TranscriptContext => {
    const instructionCount = validateMessageOrder(messages);
    const leading: Message[] = messages.slice(0, instructionCount).map((msg): Message => ({
        role: "system",
        content: chatMessageText(msg),
        timestamp: 0,
    }));
    const conversation: Message[] = messages.slice(instructionCount).map((msg): Message => {
        if (msg.role === "assistant") {
            const text = chatMessageText(msg);
            return {
                role: "assistant",
                content: text.length > 0 ? [{ type: "text", text }] : [],
                api,
                provider,
                model: modelId,
                usage: ZERO_USAGE,
                stopReason: "stop",
                timestamp: 0,
            };
        }
        if (typeof msg.content === "string") {
            return { role: "user", content: msg.content, timestamp: 0 };
        }
        const parts = msg.content.flatMap((part: ChatContentPart): Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> => {
            if (part.type === "text") return [{ type: "text", text: part.text }];
            const isAudio = part.mediaType === "audio/wav"
                || part.mediaType === "audio/x-wav"
                || part.mediaType === "audio/mpeg"
                || part.mediaType === "audio/mp3";
            if (part.mediaType.startsWith("image/")
                || api === "google-generative-ai"
                || (api === "anthropic-messages" && part.mediaType === "application/pdf")
                || (api === "openai-completions" && isAudio)) {
                return [{ type: "image", mimeType: part.mediaType, data: encodeBytesBase64(part.data) }];
            }
            return [];
        });
        return { role: "user", content: parts, timestamp: 0 };
    });
    const all: Message[] = [
        ...leading,
        ...(conversation.length > 0 ? conversation : [{ role: "user" as const, content: "", timestamp: 0 }]),
    ];
    return normalizeContext({ messages: all });
};

const applySystemCacheControl = (
    messages: unknown,
    systemProviderOptions: Record<string, Record<string, JSONValue | undefined>> | undefined,
    namespace: string,
): void => {
    if (!Array.isArray(messages) || messages.length === 0 || systemProviderOptions === undefined) return;
    const nsOpts = isRecord(systemProviderOptions[namespace]) ? systemProviderOptions[namespace] : undefined;
    const orOpts = isRecord(systemProviderOptions.openrouter) ? systemProviderOptions.openrouter : undefined;
    const compatOpts = isRecord(systemProviderOptions.openaiCompatible) ? systemProviderOptions.openaiCompatible : undefined;
    const anthropicOpts = isRecord(systemProviderOptions.anthropic) ? systemProviderOptions.anthropic : undefined;
    const cacheControl = nsOpts?.cacheControl ?? orOpts?.cacheControl ?? compatOpts?.cacheControl ?? anthropicOpts?.cacheControl ?? anthropicOpts?.cache_control;
    if (!isRecord(cacheControl)) return;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const entry = recordOf(messages[i]);
        if (entry === null) continue;
        if (entry.role === "system" || entry.role === "developer") {
            if (typeof entry.content === "string") {
                entry.content = [{ type: "text", text: entry.content, cache_control: cacheControl }];
            }
            return;
        }
        if (entry.type === "text" && typeof entry.text === "string" && entry.role === undefined) {
            entry.cache_control = cacheControl;
            return;
        }
    }
};

const assignDefined = (target: Record<string, unknown>, entries: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(entries)) {
        if (value !== undefined) target[key] = value;
        else delete target[key];
    }
};

const replacePayload = (target: Record<string, unknown>, next: Record<string, unknown>): void => {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, next);
};

const activeReasoning = (reasoning: ProviderModelRequest["reasoning"]): string | undefined =>
    reasoning !== undefined && reasoning !== "none" && reasoning !== "provider-default" ? reasoning : undefined;

const applyOpenAICompletionsPayload = (
    params: Record<string, unknown>,
    request: ProviderModelRequest,
): void => {
    const { providerModel } = request;
    const namespace = providerModel.namespace ?? providerModel.provider;
    const instructionCount = validateMessageOrder(request.messages);
    if (Array.isArray(params.messages)) {
        if (instructionCount > 0) {
            const first = recordOf(params.messages[0]);
            if (first?.role !== "system" && first?.role !== "developer") {
                params.messages.unshift({ role: "system", content: "" });
            }
        }
        for (const msg of params.messages) {
            const rec = recordOf(msg);
            if (rec?.role !== "user" || !Array.isArray(rec.content)) continue;
            rec.content = rec.content.map((item: unknown) => {
                const part = recordOf(item);
                const url = part?.type === "image_url" ? recordOf(part.image_url)?.url : undefined;
                if (typeof url !== "string" || !url.startsWith("data:audio/")) return item;
                const comma = url.indexOf(",");
                if (comma < 0) return item;
                const mediaType = url.slice(5, url.indexOf(";"));
                const format = mediaType === "audio/wav" || mediaType === "audio/x-wav" ? "wav" : "mp3";
                return { type: "input_audio", input_audio: { data: url.slice(comma + 1), format } };
            });
        }
    }
    applySystemCacheControl(params.messages, request.systemProviderOptions, namespace);
    assignDefined(params, {
        store: undefined,
        max_completion_tokens: undefined,
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        top_p: request.topP,
        top_k: providerModel.includeTopK !== false ? request.topK : undefined,
        presence_penalty: request.presencePenalty,
        frequency_penalty: request.frequencyPenalty,
        stop: request.stopSequences,
        seed: request.seed,
        reasoning_effort: activeReasoning(request.reasoning),
    });

    const nsOptions = isRecord(request.providerOptions?.[namespace]) ? request.providerOptions[namespace] : undefined;
    const compatOptions = namespace !== "openaiCompatible" && isRecord(request.providerOptions?.openaiCompatible)
        ? request.providerOptions.openaiCompatible
        : undefined;
    for (const opts of [compatOptions, nsOptions]) {
        if (opts === undefined) continue;
        for (const [key, value] of Object.entries(opts)) {
            if (value === undefined) continue;
            if (key === "promptCacheKey") params.prompt_cache_key = value;
            else if (key === "serviceTier") params.service_tier = value;
            else if (key === "reasoningEffort") params.reasoning_effort = value;
            else if (key === "logprobs") {
                if (typeof value === "number") {
                    params.logprobs = true;
                    params.top_logprobs = value;
                } else if (value === true) {
                    params.logprobs = true;
                    params.top_logprobs = 0;
                } else if (value === false) {
                    params.logprobs = false;
                }
            } else if (key === "topLogprobs") params.top_logprobs = value;
            else params[key] = value;
        }
    }

    params.stream = true;
    assignDefined(params, {
        stream_options: providerModel.compat?.supportsUsageInStreaming !== false ? { include_usage: true } : undefined,
    });
    replacePayload(params, withoutNativeTools({ ...params }, "openai"));
};

const applyOpenAIResponsesPayload = (
    params: Record<string, unknown>,
    request: ProviderModelRequest,
): void => {
    const { providerModel } = request;
    const namespace = providerModel.namespace ?? providerModel.provider;
    const nsOpts = isRecord(request.providerOptions?.[namespace]) ? request.providerOptions[namespace] : undefined;
    const reasoningEffort = typeof nsOpts?.reasoningEffort === "string"
        ? nsOpts.reasoningEffort
        : activeReasoning(request.reasoning);
    const reasoningSummary = typeof nsOpts?.reasoningSummary === "string" ? nsOpts.reasoningSummary : undefined;
    assignDefined(params, {
        store: undefined,
        instructions: undefined,
        max_output_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        top_p: request.topP,
        reasoning: reasoningEffort !== undefined || reasoningSummary !== undefined
            ? {
                ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
                ...(reasoningSummary === undefined ? {} : { summary: reasoningSummary }),
            }
            : undefined,
    });
    if (nsOpts !== undefined) {
        for (const [key, value] of Object.entries(nsOpts)) {
            if (value === undefined || key === "reasoningEffort" || key === "reasoningSummary") continue;
            if (key === "serviceTier") params.service_tier = value;
            else if (key === "promptCacheKey") params.prompt_cache_key = value;
            else params[key] = value;
        }
    }
    replacePayload(params, withoutNativeTools({ ...params }, "openai"));
};

const applyAnthropicPayload = (
    params: Record<string, unknown>,
    request: ProviderModelRequest,
): void => {
    applySystemCacheControl(params.system, request.systemProviderOptions, "anthropic");
    if (Array.isArray(params.messages)) {
        for (const msg of params.messages) {
            const rec = recordOf(msg);
            if (rec?.role !== "user" || !Array.isArray(rec.content)) continue;
            for (const item of rec.content) {
                const block = recordOf(item);
                const source = recordOf(block?.source);
                if (block?.type === "image" && source?.media_type === "application/pdf") {
                    block.type = "document";
                }
            }
        }
    }

    const anthropicOptions = isRecord(request.providerOptions?.anthropic) ? request.providerOptions.anthropic : undefined;
    const thinkingConfig = isRecord(anthropicOptions?.thinking) ? anthropicOptions.thinking : undefined;
    const budgetTokens = typeof thinkingConfig?.budgetTokens === "number"
        ? thinkingConfig.budgetTokens
        : typeof thinkingConfig?.budget_tokens === "number"
            ? thinkingConfig.budget_tokens
            : undefined;
    const baseMaxTokens = request.maxOutputTokens ?? 4096;
    const thinking = thinkingConfig?.type === "adaptive"
        ? { type: "adaptive" }
        : thinkingConfig?.type === "enabled" && budgetTokens !== undefined
            ? { type: "enabled", budget_tokens: budgetTokens }
            : thinkingConfig?.type === "disabled"
                ? { type: "disabled" }
                : undefined;
    const effortVal = typeof anthropicOptions?.effort === "string"
        ? anthropicOptions.effort
        : activeReasoning(request.reasoning);

    assignDefined(params, {
        betas: undefined,
        max_tokens: budgetTokens !== undefined ? baseMaxTokens + budgetTokens : baseMaxTokens,
        thinking,
        output_config: effortVal !== undefined
            ? { ...(isRecord(params.output_config) ? params.output_config : {}), effort: effortVal }
            : params.output_config,
        service_tier: typeof anthropicOptions?.serviceTier === "string" ? anthropicOptions.serviceTier : params.service_tier,
        temperature: thinking === undefined ? request.temperature : undefined,
        top_p: request.topP,
        top_k: request.topK,
        stop_sequences: request.stopSequences,
    });
    replacePayload(params, withoutNativeTools({ ...params }, "messages"));
};

const applyGooglePayload = (
    params: Record<string, unknown>,
    request: ProviderModelRequest,
): void => {
    const config: Record<string, unknown> = isRecord(params.config) ? { ...params.config } : {};
    assignDefined(config, {
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        topP: request.topP,
        topK: request.topK,
        presencePenalty: request.presencePenalty,
        frequencyPenalty: request.frequencyPenalty,
        stopSequences: request.stopSequences,
        seed: request.seed,
    });

    const googleOpts = isRecord(request.providerOptions?.google) ? request.providerOptions.google : undefined;
    const thinkingCfg: Record<string, unknown> = {
        ...(isRecord(config.thinkingConfig) ? config.thinkingConfig : {}),
        ...(isRecord(googleOpts?.thinkingConfig) ? googleOpts.thinkingConfig : {}),
    };
    const effort = activeReasoning(request.reasoning);
    if (effort !== undefined && thinkingCfg.thinkingLevel === undefined && thinkingCfg.thinkingBudget === undefined) {
        thinkingCfg.thinkingLevel = effort;
    }
    if (Object.keys(thinkingCfg).length > 0) config.thinkingConfig = thinkingCfg;
    if (typeof googleOpts?.serviceTier === "string") config.serviceTier = googleOpts.serviceTier;
    params.config = withoutNativeTools(config, "generate-content");
};

const applyBedrockPayload = (
    params: Record<string, unknown>,
    request: ProviderModelRequest,
): void => {
    const bedrockOpts = isRecord(request.providerOptions?.bedrock) ? request.providerOptions.bedrock : undefined;
    const reasoningCfg = isRecord(bedrockOpts?.reasoningConfig) ? bedrockOpts.reasoningConfig : undefined;
    const budgetTokens = typeof reasoningCfg?.budgetTokens === "number" ? reasoningCfg.budgetTokens : undefined;
    const maxTokens = request.maxOutputTokens !== undefined
        ? (budgetTokens !== undefined ? request.maxOutputTokens + budgetTokens : request.maxOutputTokens)
        : undefined;

    const inferenceConfig: Record<string, unknown> = { ...(isRecord(params.inferenceConfig) ? params.inferenceConfig : {}) };
    assignDefined(inferenceConfig, {
        maxTokens,
        temperature: request.temperature,
        topP: request.topP,
        stopSequences: request.stopSequences,
    });
    if (Object.keys(inferenceConfig).length > 0) params.inferenceConfig = inferenceConfig;

    const additionalFields: Record<string, unknown> = {
        ...(isRecord(params.additionalModelRequestFields) ? params.additionalModelRequestFields : {}),
        ...(isRecord(bedrockOpts?.additionalModelRequestFields) ? bedrockOpts.additionalModelRequestFields : {}),
    };
    if (reasoningCfg?.type === "adaptive") {
        additionalFields.thinking = { type: "adaptive" };
    } else if (reasoningCfg?.type === "enabled" && budgetTokens !== undefined) {
        additionalFields.thinking = { type: "enabled", budget_tokens: budgetTokens };
    }
    const effortVal = typeof reasoningCfg?.maxReasoningEffort === "string"
        ? reasoningCfg.maxReasoningEffort
        : activeReasoning(request.reasoning);
    if (effortVal !== undefined) {
        additionalFields.output_config = {
            ...(isRecord(additionalFields.output_config) ? additionalFields.output_config : {}),
            effort: effortVal,
        };
    }
    assignDefined(params, {
        additionalModelRequestFields: Object.keys(additionalFields).length > 0 ? additionalFields : undefined,
        serviceTier: typeof bedrockOpts?.serviceTier === "string" ? { type: bedrockOpts.serviceTier } : params.serviceTier,
    });
    replacePayload(params, withoutNativeTools({ ...params }, "amazon-bedrock"));
};

const awaitFetchWithAbort = async (
    fetchPromise: Promise<Response>,
    signal: AbortSignal | undefined,
): Promise<Response> => {
    if (signal === undefined) return fetchPromise;
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

const isFinishReasonMessage = (msg: string, rawStopReason: string | undefined): boolean =>
    rawStopReason !== undefined && (
        msg === `Provider finish_reason: ${rawStopReason}`
        || msg === `Provider stopped with: ${rawStopReason}`
        || msg === `Unhandled stop reason: ${rawStopReason}`
        || msg === `Response incomplete: ${rawStopReason}`
        || (rawStopReason === "refusal" && msg.includes("refused"))
    );

const buildPiModel = <TApi extends ProviderModelApi>(
    providerModel: ProviderModel,
    api: TApi,
): Model<TApi> => ({
    id: providerModel.id,
    name: providerModel.name ?? providerModel.id,
    api,
    provider: providerModel.provider,
    baseUrl: providerModel.baseUrl,
    reasoning: providerModel.reasoning ?? true,
    input: providerModel.input ? [...providerModel.input] : ["text", "image"],
    cost: providerModel.cost ? { ...providerModel.cost } : { ...ZERO_COST },
    contextWindow: providerModel.contextWindow ?? 128_000,
    maxTokens: providerModel.maxTokens ?? 16_384,
    ...(providerModel.headers === undefined ? {} : { headers: { ...providerModel.headers } }),
});

const executeSinglePiModel = async (
    request: ProviderModelRequest,
    apiOverride?: ProviderModelApi,
): Promise<ProviderModelResponse> => {
    request.signal?.throwIfAborted();
    const { providerModel } = request;
    const api = apiOverride ?? providerModel.api;

    const context = toTranscriptContext(request.messages, api, providerModel.provider, providerModel.id);
    const underlyingFetch = request.fetch ?? outboundFetch;

    let capturedPayload: Record<string, unknown> = {};
    let responseHeadersRecord: Record<string, string> | undefined;
    let partialResponseId: string | undefined;
    let partialModelId: string | undefined;
    let capturedTransportError: unknown;
    let outputObserved = false;
    let partialContent = "";
    let partialReasoning = "";
    const rawChunks: unknown[] = [];

    const prevGlobalFetch = globalThis.fetch;
    const customFetch: typeof globalThis.fetch = async (input, init) => {
        try {
            let rawPromise: Promise<Response>;
            const currentGlobalFetch = globalThis.fetch;
            if (currentGlobalFetch === customFetch) {
                globalThis.fetch = prevGlobalFetch;
            }
            try {
                rawPromise = underlyingFetch(input, init);
            } finally {
                if (currentGlobalFetch === customFetch) {
                    globalThis.fetch = customFetch;
                }
            }
            rawPromise.catch(() => {});
            const response = await awaitFetchWithAbort(rawPromise, request.signal);
            responseHeadersRecord = headersToRecord(response.headers);
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                const apiError = new APICallError({
                    message,
                    url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
                    requestBodyValues: capturedPayload,
                    statusCode: response.status,
                    responseHeaders: responseHeadersRecord,
                    responseBody: text,
                    isRetryable: isResponseRetryable(response.status, response.headers),
                    data,
                });
                capturedTransportError = apiError;
                throw apiError;
            }
            const headers = new Headers(response.headers);
            if (!headers.has("content-type")) {
                headers.set("content-type", "text/event-stream");
            }
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        } catch (error) {
            capturedTransportError ??= error;
            throw error;
        }
    };

    const onPayload = async (params: unknown): Promise<unknown> => {
        if (!isRecord(params)) return params;
        try {
            switch (api) {
                case "openai-completions":
                    applyOpenAICompletionsPayload(params, request);
                    break;
                case "openai-responses":
                    applyOpenAIResponsesPayload(params, request);
                    break;
                case "anthropic-messages":
                    applyAnthropicPayload(params, request);
                    break;
                case "google-generative-ai":
                    applyGooglePayload(params, request);
                    break;
                case "bedrock-converse-stream":
                    applyBedrockPayload(params, request);
                    break;
            }
            const overridden = await providerModel.onPayload?.(params, providerModel);
            if (isRecord(overridden)) {
                for (const key of Object.keys(params)) delete params[key];
                Object.assign(params, overridden);
            }
            capturedPayload = { ...params };
            if (api === "bedrock-converse-stream" && request.captureRequest !== undefined) {
                request.captureRequest({
                    method: "POST",
                    origin: new URL(providerModel.baseUrl).origin,
                    body: JSON.stringify(params),
                });
            }
            return params;
        } catch (error) {
            capturedTransportError = error;
            throw error;
        }
    };

    const onResponse = (resp: { status: number; headers: Record<string, string> }): void => {
        responseHeadersRecord ??= resp.headers;
    };

    const onProviderStreamEvent = (chunk: unknown): void => {
        rawChunks.push(chunk);
        if (!isRecord(chunk)) return;
        const chunkError = recordOf(chunk.error);
        if (chunkError !== null && typeof chunkError.message === "string") {
            const err = new Error(chunkError.message);
            capturedTransportError = err;
            throw err;
        }
        if (typeof chunk.id === "string") partialResponseId ??= chunk.id;
        if (typeof chunk.responseId === "string") partialResponseId ??= chunk.responseId;
        if (typeof chunk.model === "string") partialModelId ??= chunk.model;
        if (typeof chunk.modelVersion === "string") partialModelId ??= chunk.modelVersion;
        const sub = recordOf(chunk.message) ?? recordOf(chunk.response);
        if (sub !== null) {
            if (typeof sub.id === "string") partialResponseId ??= sub.id;
            if (typeof sub.model === "string") partialModelId ??= sub.model;
        }
        const sdkHttpHeaders = recordOf(recordOf(chunk.sdkHttpResponse)?.headers);
        if (sdkHttpHeaders !== null && responseHeadersRecord === undefined) {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(sdkHttpHeaders)) {
                if (typeof v === "string") headers[k] = v;
            }
            responseHeadersRecord = headers;
        }
        if (Array.isArray(chunk.choices)) {
            const delta = recordOf(recordOf(chunk.choices[0])?.delta);
            if (delta !== null
                && typeof delta.thinking === "string"
                && delta.thinking.length > 0
                && typeof delta.reasoning_content !== "string"
                && typeof delta.reasoning !== "string"
                && typeof delta.reasoning_text !== "string") {
                outputObserved = true;
                partialReasoning += delta.thinking;
                request.observeReasoning?.(delta.thinking);
            }
        }
    };

    const definedEnv: Record<string, string> | undefined = providerModel.env === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(providerModel.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
    const baseOptions = {
        apiKey: providerModel.apiKey ?? "plurnk-no-key",
        headers: request.headers,
        signal: request.signal,
        maxRetries: 0,
        cacheRetention: "none" as const,
        ...(definedEnv === undefined ? {} : { env: definedEnv }),
        onPayload,
        onResponse,
        onProviderStreamEvent,
    };

    if (api === "google-generative-ai") {
        globalThis.fetch = customFetch;
    }

    let finalUsage: Usage | undefined;
    let rawFinishReason: string | undefined;
    let stopReason: string | undefined;
    let nativeToolCalls = false;

    try {
        const piStream = (() => {
            switch (api) {
                case "openai-completions":
                    return streamOpenAICompletions(
                        {
                            ...buildPiModel(providerModel, "openai-completions"),
                            ...(providerModel.compat === undefined ? {} : { compat: { ...providerModel.compat } }),
                        },
                        context,
                        { ...baseOptions, fetch: customFetch },
                    );
                case "openai-responses":
                    return streamOpenAIResponses(
                        buildPiModel(providerModel, "openai-responses"),
                        context,
                        { ...baseOptions, fetch: customFetch },
                    );
                case "anthropic-messages":
                    return streamAnthropic(
                        buildPiModel(providerModel, "anthropic-messages"),
                        context,
                        { ...baseOptions, fetch: customFetch },
                    );
                case "google-generative-ai":
                    return streamGoogleGenerativeAi(
                        buildPiModel(providerModel, "google-generative-ai"),
                        context,
                        baseOptions,
                    );
                case "bedrock-converse-stream":
                    return streamBedrockConverseStream(
                        buildPiModel(providerModel, "bedrock-converse-stream"),
                        context,
                        baseOptions,
                    );
            }
        })();

        for await (const event of piStream) {
            if (event.type === "thinking_delta") {
                if (event.delta.length > 0) {
                    outputObserved = true;
                    partialReasoning += event.delta;
                    request.observeReasoning?.(event.delta);
                }
            } else if (event.type === "text_delta") {
                if (event.delta.length > 0) {
                    outputObserved = true;
                    partialContent += event.delta;
                    request.observeText?.(event.delta);
                }
            } else if (event.type === "toolcall_start" || event.type === "toolcall_end") {
                nativeToolCalls = true;
            } else if (event.type === "done") {
                stopReason = event.message.stopReason;
                rawFinishReason = event.message.rawStopReason;
                finalUsage = event.message.usage;
                if (event.message.responseId !== undefined) partialResponseId ??= event.message.responseId;
                if (event.message.responseModel !== undefined) partialModelId ??= event.message.responseModel;
                if (event.message.content.some((block) => block.type === "toolCall")) {
                    nativeToolCalls = true;
                }
            } else if (event.type === "error") {
                if (capturedTransportError !== undefined) {
                    throw capturedTransportError;
                }
                if (request.signal?.aborted) {
                    throw request.signal.reason ?? new Error("Request was aborted");
                }
                const errMsg = event.error.errorMessage ?? "";
                const rawStop = event.error.rawStopReason;
                if (isFinishReasonMessage(errMsg, rawStop)) {
                    stopReason = event.error.stopReason;
                    rawFinishReason = rawStop;
                    finalUsage = event.error.usage;
                    if (event.error.responseId !== undefined) partialResponseId ??= event.error.responseId;
                    if (event.error.responseModel !== undefined) partialModelId ??= event.error.responseModel;
                    continue;
                }
                const braceIndex = errMsg.indexOf("{");
                if (braceIndex >= 0) {
                    try {
                        const parsedErr: unknown = JSON.parse(errMsg.slice(braceIndex));
                        if (isRecord(parsedErr) && parsedErr.type === "error") {
                            rawChunks.push(parsedErr);
                            const inner = recordOf(parsedErr.error);
                            if (typeof inner?.message === "string") {
                                throw new Error(inner.message);
                            }
                        }
                    } catch (innerErr) {
                        if (innerErr instanceof Error && !(innerErr instanceof SyntaxError)) {
                            throw innerErr;
                        }
                    }
                }
                if (errMsg === "Stream ended without finish_reason"
                    || errMsg === "Anthropic stream ended without a stop reason"
                    || errMsg === "Google stream ended without a finish reason") {
                    throw new Error("Response stream ended without a finish reason.");
                }
                if (errMsg.trim().toLowerCase() === "terminated") {
                    throw new TypeError("terminated");
                }
                throw new Error(errMsg || "Provider stream error");
            }
        }
        request.signal?.throwIfAborted();
    } catch (error) {
        if (APICallError.isInstance(error) && rawChunks.length === 0 && !outputObserved) {
            throw error;
        }
        const partialResponse: ProviderChargeEvidence["response"] | undefined =
            partialResponseId !== undefined || responseHeadersRecord !== undefined
                ? {
                    ...(partialResponseId === undefined ? {} : { id: partialResponseId }),
                    ...(responseHeadersRecord === undefined ? {} : { headers: responseHeadersRecord }),
                }
                : undefined;
        throw preserveStreamFailure(
            error,
            {
                rawBody: rawChunks,
                content: partialContent,
                reasoning: partialReasoning,
                response: partialResponse,
            },
            outputObserved,
            request.signal,
        );
    } finally {
        if (api === "google-generative-ai") {
            globalThis.fetch = prevGlobalFetch;
        }
    }

    const evidence = extractEvidence(rawChunks);
    const accountingUsage = wireUsageEvidenceOf(rawChunks);
    const content = partialContent || evidence.content;
    const reasoningText = evidence.reasoning || partialReasoning || "";
    const metadata = metadataOf(rawChunks);
    const finalId = partialResponseId ?? (typeof metadata.id === "string" ? metadata.id : undefined);
    const finalModelId = partialModelId
        ?? (typeof metadata.model === "string" ? metadata.model : undefined)
        ?? providerModel.id;
    const effectiveFinishReason = nativeToolCalls
        ? "tool_calls"
        : finishReasonOf(stopReason, rawFinishReason);

    return {
        model: finalModelId,
        content,
        reasoning: reasoningText,
        reasoningProjected: evidence.reasoningProjected,
        wire: wireEmissionOf(rawChunks),
        finishReason: effectiveFinishReason,
        ...(rawFinishReason === undefined ? {} : { rawFinishReason }),
        ...settledUsage(rawChunks, finalUsage),
        metadata,
        logprobs: evidence.logprobs,
        chargeEvidence: {
            ...(wireChargeEvidenceOf(rawChunks) === undefined
                ? {}
                : { charge: wireChargeEvidenceOf(rawChunks) }),
            ...(accountingUsage === undefined ? {} : { usage: accountingUsage }),
            response: {
                ...(finalId === undefined ? {} : { id: finalId }),
                ...(responseHeadersRecord === undefined ? {} : { headers: responseHeadersRecord }),
            },
        },
        ...(request.captureRawBody ? { rawBody: rawChunks } : {}),
        warnings: [],
    };
};

export const executeProviderModel = async (
    request: ProviderModelRequest,
): Promise<ProviderModelResponse> => {
    try {
        if (request.providerModel.xaiPreferResponses === true && request.providerModel.api === "openai-responses") {
            try {
                return await executeSinglePiModel(request, "openai-responses");
            } catch (error) {
                if (APICallError.isInstance(error)
                    && (error.statusCode === 404 || error.statusCode === 405 || error.statusCode === 501)) {
                    return await executeSinglePiModel(request, "openai-completions");
                }
                throw error;
            }
        }
        return await executeSinglePiModel(request);
    } catch (cause) {
        if (request.signal?.aborted) {
            throw retainStreamFailureValues(cause, new Error("Provider call cancelled", { cause: request.signal.reason }));
        }
        throw normalizeRetryAttemptError(cause);
    }
};

const SDK_OWNED_BODY_KEYS = [
    "model",
    "messages",
    "stream",
    "stream_options",
    "tools",
    "tool_choice",
    "functions",
    "function_call",
    "parallel_tool_calls",
] as const;

export const executeOpenAICompatible = async (
    request: OpenAICompatibleRequest,
): Promise<ProviderModelResponse> => {
    for (const key of SDK_OWNED_BODY_KEYS) {
        if (Object.hasOwn(request.body, key)) {
            throw new TypeError(`OpenAI-compatible request extensions may not override SDK-owned field ${JSON.stringify(key)}`);
        }
    }
    const providerModel: ProviderModel = {
        id: request.model,
        name: request.model,
        api: "openai-completions",
        provider: "plurnk",
        namespace: "plurnk",
        baseUrl: baseUrl(request.url),
        apiKey: "plurnk-no-key",
        headers: request.headers,
        includeTopK: true,
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens",
            supportsReasoningEffort: true,
            supportsUsageInStreaming: true,
            supportsFinishReason: true,
        },
        onPayload: (params) => {
            if (!isRecord(params)) return params;
            return withoutNativeTools({
                ...params,
                ...request.body,
                stream: params.stream,
                ...(params.stream_options !== undefined ? { stream_options: params.stream_options } : {}),
            }, "openai");
        },
    };
    return executeProviderModel({
        providerModel,
        headers: {},
        messages: request.messages,
        signal: request.signal,
        fetch: request.fetch,
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

export type TransportFailureEvidence = {
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
): TransportFailureEvidence => {
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
    const httpStatus = (value: unknown): number | undefined =>
        isSafeInteger(value) && value >= 100 && value <= 599 ? value : undefined;
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
