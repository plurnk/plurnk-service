import { isRecord } from "@plurnk/plurnk-contracts";
import { outboundFetch } from "@plurnk/plurnk-meta";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import { APICallError, JSONParseError, TypeValidationError } from "./errors.ts";
import { withoutNativeTools } from "./native-tools.ts";
import {
    encodeBytesBase64,
    extractErrorMessage,
    headersToRecord,
    isResponseRetryable,
    piContextFromPrompt,
    toUnifiedFinishReason,
} from "./modelTransport.ts";
import type {
    ModelFinishReason,
    ModelPromptMessage,
    ModelTransport,
    ModelTransportCallOptions,
    ModelTransportResult,
    ModelUsage,
} from "./types.ts";

export type VendorTransportSettings = {
    apiKey?: string;
    baseURL?: string;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
};

export const createXaiModel = (
    modelId: string,
    settings: VendorTransportSettings = {},
): ModelTransport => {
    const resolvedBaseUrl = (settings.baseURL ?? "https://api.x.ai/v1").replace(/\/+$/, "");
    const endpointUrl = `${resolvedBaseUrl}/responses`;
    const underlyingFetch = settings.fetch ?? outboundFetch;

    const buildPiModel = (callHeaders?: Record<string, string | undefined>): Model<"openai-responses"> => {
        const mergedHeaders: Record<string, string> = { ...settings.headers };
        if (callHeaders !== undefined) {
            for (const [key, value] of Object.entries(callHeaders)) {
                if (value !== undefined) mergedHeaders[key] = value;
            }
        }
        return {
            id: modelId,
            name: modelId,
            api: "openai-responses",
            provider: "xai",
            baseUrl: resolvedBaseUrl,
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
            headers: mergedHeaders,
        };
    };

    const applyXaiPayloadOptions = (
        params: Record<string, unknown>,
        callOptions: ModelTransportCallOptions,
        targetModelId: string,
    ): void => {
        delete params.store;
        params.model = targetModelId;
        const input: unknown[] = [];
        for (const message of callOptions.prompt) {
            if (message.role === "system") {
                input.push({ role: "system", content: message.content });
            } else if (message.role === "assistant") {
                const text = message.content
                    .filter((p): p is Extract<typeof message.content[number], { type: "text" }> => p.type === "text")
                    .map((p) => p.text)
                    .join("");
                input.push({
                    role: "assistant",
                    content: [{ type: "output_text", text }],
                });
            } else {
                const contentParts: unknown[] = [];
                for (const part of message.content) {
                    if (part.type === "text") {
                        contentParts.push({ type: "input_text", text: part.text });
                    } else if (part.mediaType.startsWith("image/")) {
                        const rawBytes = part.data instanceof Uint8Array
                            ? part.data
                            : isRecord(part.data) && part.data.data instanceof Uint8Array
                                ? part.data.data
                                : undefined;
                        const b64 = rawBytes !== undefined
                            ? encodeBytesBase64(rawBytes)
                            : typeof part.data === "string"
                                ? part.data
                                : isRecord(part.data) && typeof part.data.data === "string"
                                    ? part.data.data
                                    : "";
                        contentParts.push({
                            type: "input_image",
                            image_url: `data:${part.mediaType};base64,${b64}`,
                        });
                    }
                }
                input.push({ role: "user", content: contentParts });
            }
        }
        params.input = input;
        if (callOptions.maxOutputTokens !== undefined) params.max_output_tokens = callOptions.maxOutputTokens;
        else delete params.max_output_tokens;
        if (callOptions.temperature !== undefined) params.temperature = callOptions.temperature;
        else delete params.temperature;
        if (callOptions.topP !== undefined) params.top_p = callOptions.topP;
        else delete params.top_p;

        const xaiOptions = isRecord(callOptions.providerOptions?.xai) ? callOptions.providerOptions.xai : undefined;
        const reasoningEffort = typeof xaiOptions?.reasoningEffort === "string"
            ? xaiOptions.reasoningEffort
            : callOptions.reasoning !== undefined
                && callOptions.reasoning !== "none"
                && callOptions.reasoning !== "provider-default"
                ? callOptions.reasoning
                : undefined;
        const reasoningSummary = typeof xaiOptions?.reasoningSummary === "string"
            ? xaiOptions.reasoningSummary
            : undefined;
        if (reasoningEffort !== undefined || reasoningSummary !== undefined) {
            params.reasoning = {
                ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
                ...(reasoningSummary === undefined ? {} : { summary: reasoningSummary }),
            };
        } else {
            delete params.reasoning;
        }
        if (xaiOptions !== undefined) {
            for (const [key, value] of Object.entries(xaiOptions)) {
                if (value === undefined || key === "reasoningEffort" || key === "reasoningSummary") continue;
                if (key === "serviceTier") {
                    params.service_tier = value;
                    continue;
                }
                params[key] = value;
            }
        }
        const cleaned = withoutNativeTools({ ...params }, "openai");
        for (const key of Object.keys(params)) delete params[key];
        Object.assign(params, cleaned);
    };

    return {
        provider: "xai.responses",
        modelId,
        async execute(callOptions: ModelTransportCallOptions): Promise<ModelTransportResult> {
            callOptions.abortSignal?.throwIfAborted();
            if (!callOptions.streaming) {
                const params: Record<string, unknown> = { model: modelId, input: [] };
                applyXaiPayloadOptions(params, callOptions, modelId);
                const mergedHeaders = new Headers({ "Content-Type": "application/json" });
                if (settings.apiKey !== undefined && settings.apiKey.length > 0) {
                    mergedHeaders.set("Authorization", `Bearer ${settings.apiKey}`);
                }
                if (settings.headers !== undefined) {
                    for (const [key, value] of Object.entries(settings.headers)) {
                        if (value !== undefined) mergedHeaders.set(key, value);
                    }
                }
                if (callOptions.headers !== undefined) {
                    for (const [key, value] of Object.entries(callOptions.headers)) {
                        if (value !== undefined) mergedHeaders.set(key, value);
                    }
                }
                const response = await underlyingFetch(endpointUrl, {
                    method: "POST",
                    headers: headersToRecord(mergedHeaders),
                    body: JSON.stringify(params),
                    ...(callOptions.abortSignal === undefined ? {} : { signal: callOptions.abortSignal }),
                });
                const responseHeadersRecord = headersToRecord(response.headers);
                if (!response.ok) {
                    const text = await response.text().catch(() => "");
                    const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                    throw new APICallError({
                        message,
                        url: endpointUrl,
                        requestBodyValues: params,
                        statusCode: response.status,
                        responseHeaders: responseHeadersRecord,
                        responseBody: text,
                        isRetryable: isResponseRetryable(response.status, response.headers),
                        data,
                    });
                }
                const text = await response.text();
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch (cause) {
                    throw new APICallError({
                        message: "Failed to process successful response",
                        url: endpointUrl,
                        requestBodyValues: params,
                        statusCode: response.status,
                        responseHeaders: responseHeadersRecord,
                        responseBody: text,
                        cause: new JSONParseError({ text, cause }),
                        isRetryable: isResponseRetryable(response.status, response.headers),
                    });
                }
                if (!isRecord(parsed) || !Array.isArray(parsed.output)) {
                    throw new APICallError({
                        message: "Failed to process successful response",
                        url: endpointUrl,
                        requestBodyValues: params,
                        statusCode: response.status,
                        responseHeaders: responseHeadersRecord,
                        responseBody: text,
                        cause: new TypeValidationError({
                            value: parsed,
                            cause: new Error("Expected output array in responses payload"),
                        }),
                        isRetryable: isResponseRetryable(response.status, response.headers),
                    });
                }
                let content = "";
                let reasoning = "";
                let nativeToolCalls = false;
                for (const item of parsed.output) {
                    if (!isRecord(item)) continue;
                    if (item.type === "reasoning" && Array.isArray(item.summary)) {
                        for (const part of item.summary) {
                            if (isRecord(part) && typeof part.text === "string") {
                                reasoning += part.text;
                            }
                        }
                    } else if (item.type === "message" && Array.isArray(item.content)) {
                        for (const part of item.content) {
                            if (isRecord(part) && typeof part.text === "string") {
                                content += part.text;
                            }
                        }
                    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
                        nativeToolCalls = true;
                    }
                }
                const statusStr = typeof parsed.status === "string" ? parsed.status : "completed";
                const rawStopReason = statusStr === "incomplete"
                    ? (isRecord(parsed.incomplete_details) && typeof parsed.incomplete_details.reason === "string"
                        ? parsed.incomplete_details.reason
                        : "length")
                    : statusStr === "failed" || statusStr === "cancelled"
                        ? "error"
                        : nativeToolCalls
                            ? "tool_calls"
                            : "stop";
                const usageObj = isRecord(parsed.usage) ? parsed.usage : undefined;
                const inputTotal = typeof usageObj?.input_tokens === "number"
                    ? usageObj.input_tokens
                    : typeof usageObj?.prompt_tokens === "number" ? usageObj.prompt_tokens : undefined;
                const outputTotal = typeof usageObj?.output_tokens === "number"
                    ? usageObj.output_tokens
                    : typeof usageObj?.completion_tokens === "number" ? usageObj.completion_tokens : undefined;
                const inputDetails = isRecord(usageObj?.input_tokens_details) ? usageObj.input_tokens_details : undefined;
                const outputDetails = isRecord(usageObj?.output_tokens_details) ? usageObj.output_tokens_details : undefined;
                const cached = typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : 0;
                const reasoningToks = typeof outputDetails?.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : undefined;
                return {
                    content,
                    reasoning,
                    ...(nativeToolCalls ? { nativeToolCalls: true } : {}),
                    finishReason: {
                        unified: toUnifiedFinishReason(rawStopReason),
                        raw: rawStopReason,
                    },
                    usage: {
                        inputTokens: inputTotal,
                        outputTokens: outputTotal,
                        totalTokens: inputTotal !== undefined && outputTotal !== undefined
                            ? inputTotal + outputTotal
                            : undefined,
                        inputTokenDetails: {
                            noCacheTokens: inputTotal !== undefined ? inputTotal - cached : undefined,
                            cacheReadTokens: cached,
                            cacheWriteTokens: undefined,
                        },
                        outputTokenDetails: {
                            textTokens: outputTotal !== undefined && reasoningToks !== undefined
                                ? outputTotal - reasoningToks
                                : outputTotal,
                            reasoningTokens: reasoningToks,
                        },
                    },
                    rawChunks: [],
                    response: {
                        id: typeof parsed.id === "string" ? parsed.id : undefined,
                        modelId: typeof parsed.model === "string" ? parsed.model : modelId,
                        headers: responseHeadersRecord,
                        body: parsed,
                    },
                    warnings: [],
                };
            }

            let capturedRequestBody: unknown = {};
            let responseHeadersRecord: Record<string, string> | undefined;
            let settleHeaders!: () => void;
            let failHeaders!: (error: unknown) => void;
            const headersReady = new Promise<void>((resolve, reject) => {
                settleHeaders = resolve;
                failHeaders = reject;
            });

            const customFetch: typeof globalThis.fetch = async (input, init) => {
                try {
                    const response = await underlyingFetch(input, init);
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
                    callOptions.observeResponse?.({ headers: responseHeadersRecord });
                    settleHeaders();
                    return response;
                } catch (error) {
                    failHeaders(error);
                    throw error;
                }
            };

            let payloadError: unknown;
            let streamError: unknown;
            let content = "";
            let reasoning = "";
            let finishReason: ModelFinishReason = { unified: "other", raw: undefined };
            let usage: ModelUsage | undefined;
            const rawChunks: unknown[] = [];

            const piContext = piContextFromPrompt(callOptions.prompt, "openai-responses", "xai", modelId);
            const piStream = streamOpenAIResponses(buildPiModel(callOptions.headers), piContext, {
                apiKey: settings.apiKey ?? "plurnk-no-key",
                signal: callOptions.abortSignal,
                maxRetries: 0,
                fetch: customFetch,
                onPayload: (params) => {
                    if (!isRecord(params)) return;
                    try {
                        applyXaiPayloadOptions(params, callOptions, modelId);
                        params.stream = true;
                        capturedRequestBody = { ...params };
                    } catch (error) {
                        payloadError = error;
                        throw error;
                    }
                },
                onProviderStreamEvent: (event) => {
                    rawChunks.push(event);
                    callOptions.observeRawChunk?.(event);
                },
            });

            const consumePromise = (async () => {
                for await (const event of piStream) {
                    if (event.type === "thinking_delta") {
                        reasoning += event.delta;
                        callOptions.observeReasoning?.(event.delta);
                    } else if (event.type === "text_delta") {
                        content += event.delta;
                        callOptions.observeText?.(event.delta);
                    } else if (event.type === "done") {
                        const rawFinish = event.message.rawStopReason;
                        const totalIn = event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite;
                        const totalOut = event.message.usage.output;
                        finishReason = {
                            unified: toUnifiedFinishReason(rawFinish),
                            raw: rawFinish,
                        };
                        usage = {
                            inputTokens: totalIn,
                            outputTokens: totalOut,
                            totalTokens: totalIn + totalOut,
                            inputTokenDetails: {
                                noCacheTokens: event.message.usage.input,
                                cacheReadTokens: event.message.usage.cacheRead,
                                cacheWriteTokens: event.message.usage.cacheWrite > 0 ? event.message.usage.cacheWrite : undefined,
                            },
                            outputTokenDetails: {
                                textTokens: totalOut,
                                reasoningTokens: undefined,
                            },
                        };
                    } else if (event.type === "error") {
                        streamError ??= new Error(event.error.errorMessage ?? "xAI stream error");
                    }
                }
            })();

            await Promise.race([
                headersReady,
                consumePromise.then(() => {
                    if (payloadError !== undefined) throw payloadError;
                }),
            ]);
            if (payloadError !== undefined) throw payloadError;
            await consumePromise;
            if (streamError !== undefined) throw streamError;
            return {
                content,
                reasoning,
                finishReason,
                usage,
                rawChunks,
                response: {
                    ...(responseHeadersRecord === undefined ? {} : { headers: responseHeadersRecord }),
                },
                warnings: [],
            };
        },
    };
};

export const createAnthropicModel = (
    modelId: string,
    settings: VendorTransportSettings = {},
): ModelTransport => {
    const resolvedBaseUrl = (settings.baseURL ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    const normalizedBaseUrl = resolvedBaseUrl.endsWith("/v1")
        ? resolvedBaseUrl.slice(0, -3)
        : resolvedBaseUrl;
    const messagesEndpointUrl = `${normalizedBaseUrl}/v1/messages`;
    const underlyingFetch = settings.fetch ?? outboundFetch;

    const buildPiModel = (callHeaders?: Record<string, string | undefined>): Model<"anthropic-messages"> => {
        const mergedHeaders: Record<string, string> = { ...settings.headers };
        if (callHeaders !== undefined) {
            for (const [key, value] of Object.entries(callHeaders)) {
                if (value !== undefined) mergedHeaders[key] = value;
            }
        }
        return {
            id: modelId,
            name: modelId,
            api: "anthropic-messages",
            provider: "anthropic",
            baseUrl: normalizedBaseUrl,
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 16384,
            headers: mergedHeaders,
        };
    };

    const applyAnthropicPayloadOptions = (
        params: Record<string, unknown>,
        callOptions: ModelTransportCallOptions,
        targetModelId: string,
        streaming: boolean,
    ): void => {
        params.model = targetModelId;
        if (streaming) params.stream = true;
        else delete params.stream;
        const systemMessages = callOptions.prompt.filter(
            (m): m is Extract<ModelPromptMessage, { role: "system" }> => m.role === "system",
        );
        if (systemMessages.length > 0) {
            params.system = systemMessages.map((sys) => {
                const anthropicOpts = isRecord(sys.providerOptions?.anthropic)
                    ? sys.providerOptions.anthropic
                    : undefined;
                const cacheControl = anthropicOpts?.cacheControl ?? anthropicOpts?.cache_control;
                return {
                    type: "text",
                    text: sys.content,
                    ...(isRecord(cacheControl) ? { cache_control: cacheControl } : {}),
                };
            });
        } else {
            delete params.system;
        }
        const conversation = callOptions.prompt.filter(
            (m): m is Exclude<ModelPromptMessage, { role: "system" }> => m.role !== "system",
        );
        params.messages = conversation.map((msg) => {
            if (msg.role === "assistant") {
                return {
                    role: "assistant",
                    content: msg.content
                        .filter((p): p is Extract<typeof msg.content[number], { type: "text" }> => p.type === "text")
                        .map((p) => ({ type: "text", text: p.text })),
                };
            }
            const parts: unknown[] = [];
            for (const part of msg.content) {
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
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: part.mediaType,
                            data: base64,
                        },
                    });
                } else if (part.mediaType === "application/pdf") {
                    parts.push({
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: base64,
                        },
                    });
                }
            }
            return { role: "user", content: parts };
        });

        const anthropicOptions = isRecord(callOptions.providerOptions?.anthropic)
            ? callOptions.providerOptions.anthropic
            : undefined;
        const thinkingConfig = isRecord(anthropicOptions?.thinking)
            ? anthropicOptions.thinking
            : undefined;
        const budgetTokens = typeof thinkingConfig?.budgetTokens === "number"
            ? thinkingConfig.budgetTokens
            : typeof thinkingConfig?.budget_tokens === "number"
                ? thinkingConfig.budget_tokens
                : undefined;
        const baseMaxTokens = callOptions.maxOutputTokens ?? 4096;
        params.max_tokens = budgetTokens !== undefined ? baseMaxTokens + budgetTokens : baseMaxTokens;

        if (thinkingConfig !== undefined) {
            if (thinkingConfig.type === "adaptive") {
                params.thinking = { type: "adaptive" };
            } else if (thinkingConfig.type === "enabled" && budgetTokens !== undefined) {
                params.thinking = { type: "enabled", budget_tokens: budgetTokens };
            } else if (thinkingConfig.type === "disabled") {
                params.thinking = { type: "disabled" };
            }
        } else {
            delete params.thinking;
        }

        const effortVal = typeof anthropicOptions?.effort === "string"
            ? anthropicOptions.effort
            : callOptions.reasoning !== undefined
                && callOptions.reasoning !== "none"
                && callOptions.reasoning !== "provider-default"
                ? callOptions.reasoning
                : undefined;
        if (effortVal !== undefined) {
            params.output_config = {
                ...(isRecord(params.output_config) ? params.output_config : {}),
                effort: effortVal,
            };
        }
        if (typeof anthropicOptions?.serviceTier === "string") {
            params.service_tier = anthropicOptions.serviceTier;
        }
        if (callOptions.temperature !== undefined && params.thinking === undefined) {
            params.temperature = callOptions.temperature;
        } else {
            delete params.temperature;
        }
        if (callOptions.topP !== undefined) params.top_p = callOptions.topP;
        if (callOptions.topK !== undefined) params.top_k = callOptions.topK;
        if (callOptions.stopSequences !== undefined) params.stop_sequences = callOptions.stopSequences;

        const cleaned = withoutNativeTools({ ...params }, "messages");
        for (const key of Object.keys(params)) delete params[key];
        Object.assign(params, cleaned);
    };

    return {
        provider: "anthropic.messages",
        modelId,
        async execute(callOptions: ModelTransportCallOptions): Promise<ModelTransportResult> {
            callOptions.abortSignal?.throwIfAborted();
            if (!callOptions.streaming) {
                const params: Record<string, unknown> = { model: modelId, messages: [], max_tokens: 4096 };
                applyAnthropicPayloadOptions(params, callOptions, modelId, false);
                const mergedHeaders = new Headers({
                    "Content-Type": "application/json",
                    "anthropic-version": "2023-06-01",
                });
                if (settings.apiKey !== undefined && settings.apiKey.length > 0) {
                    mergedHeaders.set("x-api-key", settings.apiKey);
                }
                if (settings.headers !== undefined) {
                    for (const [key, value] of Object.entries(settings.headers)) {
                        if (value !== undefined) mergedHeaders.set(key, value);
                    }
                }
                if (callOptions.headers !== undefined) {
                    for (const [key, value] of Object.entries(callOptions.headers)) {
                        if (value !== undefined) mergedHeaders.set(key, value);
                    }
                }
                const response = await underlyingFetch(messagesEndpointUrl, {
                    method: "POST",
                    headers: headersToRecord(mergedHeaders),
                    body: JSON.stringify(params),
                    ...(callOptions.abortSignal === undefined ? {} : { signal: callOptions.abortSignal }),
                });
                const responseHeadersRecord = headersToRecord(response.headers);
                if (!response.ok) {
                    const text = await response.text().catch(() => "");
                    const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                    throw new APICallError({
                        message,
                        url: messagesEndpointUrl,
                        requestBodyValues: params,
                        statusCode: response.status,
                        responseHeaders: responseHeadersRecord,
                        responseBody: text,
                        isRetryable: isResponseRetryable(response.status, response.headers),
                        data,
                    });
                }
                const text = await response.text();
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch (cause) {
                    throw new APICallError({
                        message: "Failed to process successful response",
                        url: messagesEndpointUrl,
                        requestBodyValues: params,
                        statusCode: response.status,
                        responseHeaders: responseHeadersRecord,
                        responseBody: text,
                        cause: new JSONParseError({ text, cause }),
                        isRetryable: isResponseRetryable(response.status, response.headers),
                    });
                }
                if (!isRecord(parsed) || !Array.isArray(parsed.content)) {
                    throw new APICallError({
                        message: "Failed to process successful response",
                        url: messagesEndpointUrl,
                        requestBodyValues: params,
                        statusCode: response.status,
                        responseHeaders: responseHeadersRecord,
                        responseBody: text,
                        cause: new TypeValidationError({
                            value: parsed,
                            cause: new Error("Expected content array in Anthropic message response"),
                        }),
                        isRetryable: isResponseRetryable(response.status, response.headers),
                    });
                }
                let content = "";
                let reasoning = "";
                let nativeToolCalls = false;
                for (const block of parsed.content) {
                    if (!isRecord(block)) continue;
                    if (block.type === "thinking" && typeof block.thinking === "string") {
                        reasoning += block.thinking;
                    } else if (block.type === "text" && typeof block.text === "string") {
                        content += block.text;
                    } else if (block.type === "tool_use") {
                        nativeToolCalls = true;
                    }
                }
                const rawFinish = typeof parsed.stop_reason === "string"
                    ? parsed.stop_reason
                    : "end_turn";
                const rawUsage = isRecord(parsed.usage) ? parsed.usage : undefined;
                const inputTok = typeof rawUsage?.input_tokens === "number" ? rawUsage.input_tokens : 0;
                const outputTok = typeof rawUsage?.output_tokens === "number" ? rawUsage.output_tokens : 0;
                const cacheRead = typeof rawUsage?.cache_read_input_tokens === "number" ? rawUsage.cache_read_input_tokens : 0;
                const cacheWrite = typeof rawUsage?.cache_creation_input_tokens === "number" ? rawUsage.cache_creation_input_tokens : 0;
                const inputTotal = inputTok + cacheRead + cacheWrite;
                return {
                    content,
                    reasoning,
                    ...(nativeToolCalls ? { nativeToolCalls: true } : {}),
                    finishReason: {
                        unified: toUnifiedFinishReason(rawFinish),
                        raw: rawFinish,
                    },
                    usage: {
                        inputTokens: inputTotal,
                        outputTokens: outputTok,
                        totalTokens: inputTotal + outputTok,
                        inputTokenDetails: {
                            noCacheTokens: inputTok,
                            cacheReadTokens: cacheRead,
                            cacheWriteTokens: cacheWrite > 0 ? cacheWrite : undefined,
                        },
                        outputTokenDetails: {
                            textTokens: outputTok,
                            reasoningTokens: undefined,
                        },
                    },
                    rawChunks: [],
                    response: {
                        id: typeof parsed.id === "string" ? parsed.id : undefined,
                        modelId: typeof parsed.model === "string" ? parsed.model : modelId,
                        headers: responseHeadersRecord,
                        body: parsed,
                    },
                    warnings: [],
                };
            }

            let capturedRequestBody: unknown = {};
            let responseHeadersRecord: Record<string, string> | undefined;
            let settleHeaders!: () => void;
            let failHeaders!: (error: unknown) => void;
            const headersReady = new Promise<void>((resolve, reject) => {
                settleHeaders = resolve;
                failHeaders = reject;
            });

            const originalEventsQueue: unknown[] = [];
            const sseErrorEvents: Array<{ rawEvent: Record<string, unknown>; error: unknown }> = [];
            let rawStreamReadError: unknown;
            let lastStopReason: string | undefined;
            const lastUsage: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
            } = {};

            const inspectAnthropicSse = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
                const reader = body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();
                let buffer = "";
                let closed = false;
                const enqueue = (ctrl: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array): void => {
                    if (closed) return;
                    try {
                        ctrl.enqueue(bytes);
                    } catch {
                        closed = true;
                    }
                };
                const close = (ctrl: ReadableStreamDefaultController<Uint8Array>): void => {
                    if (closed) return;
                    closed = true;
                    try {
                        ctrl.close();
                    } catch {
                        // Ignore
                    }
                };
                const handleBlock = (block: string, ctrl: ReadableStreamDefaultController<Uint8Array>): boolean => {
                    const lines = block.split(/\r?\n/);
                    const dataLines: string[] = [];
                    for (const line of lines) {
                        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
                    }
                    if (dataLines.length === 0) {
                        if (block.length > 0) enqueue(ctrl, encoder.encode(`${block}\n\n`));
                        return false;
                    }
                    const data = dataLines.join("\n").trim();
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(data);
                    } catch {
                        enqueue(ctrl, encoder.encode(`${block}\n\n`));
                        return false;
                    }
                    if (!isRecord(parsed)) {
                        enqueue(ctrl, encoder.encode(`${block}\n\n`));
                        return false;
                    }
                    if (parsed.type === "error") {
                        const errObj = isRecord(parsed.error) ? parsed.error : parsed;
                        const msg = typeof errObj.message === "string" ? errObj.message : JSON.stringify(errObj);
                        sseErrorEvents.push({ rawEvent: parsed, error: new Error(msg) });
                        close(ctrl);
                        return true;
                    }
                    if (parsed.type === "message_start" && isRecord(parsed.message) && isRecord(parsed.message.usage)) {
                        const u = parsed.message.usage;
                        if (typeof u.input_tokens === "number") lastUsage.input_tokens = u.input_tokens;
                        if (typeof u.output_tokens === "number") lastUsage.output_tokens = u.output_tokens;
                        if (typeof u.cache_read_input_tokens === "number") lastUsage.cache_read_input_tokens = u.cache_read_input_tokens;
                        if (typeof u.cache_creation_input_tokens === "number") lastUsage.cache_creation_input_tokens = u.cache_creation_input_tokens;
                    }
                    if (parsed.type === "message_delta") {
                        if (isRecord(parsed.delta) && typeof parsed.delta.stop_reason === "string") {
                            lastStopReason = parsed.delta.stop_reason;
                        }
                        if (isRecord(parsed.usage)) {
                            const u = parsed.usage;
                            if (typeof u.input_tokens === "number") lastUsage.input_tokens = u.input_tokens;
                            if (typeof u.output_tokens === "number") lastUsage.output_tokens = u.output_tokens;
                            if (typeof u.cache_read_input_tokens === "number") lastUsage.cache_read_input_tokens = u.cache_read_input_tokens;
                            if (typeof u.cache_creation_input_tokens === "number") lastUsage.cache_creation_input_tokens = u.cache_creation_input_tokens;
                        }
                    }
                    originalEventsQueue.push(parsed);
                    enqueue(ctrl, encoder.encode(`${block}\n\n`));
                    return false;
                };
                return new ReadableStream<Uint8Array>({
                    async pull(ctrl) {
                        try {
                            while (true) {
                                const boundary = buffer.match(/\r?\n\r?\n/);
                                if (boundary?.index !== undefined) {
                                    const block = buffer.slice(0, boundary.index);
                                    buffer = buffer.slice(boundary.index + boundary[0].length);
                                    if (handleBlock(block, ctrl)) return;
                                    return;
                                }
                                const { done, value } = await reader.read();
                                if (done) {
                                    buffer += decoder.decode();
                                    if (buffer.trim().length > 0) {
                                        if (handleBlock(buffer, ctrl)) return;
                                        buffer = "";
                                    }
                                    close(ctrl);
                                    return;
                                }
                                buffer += decoder.decode(value, { stream: true });
                            }
                        } catch (error) {
                            rawStreamReadError = error;
                            close(ctrl);
                        }
                    },
                    async cancel(reason) {
                        closed = true;
                        await reader.cancel(reason).catch(() => {});
                    },
                });
            };

            const customFetch: typeof globalThis.fetch = async (input, init) => {
                try {
                    const response = await underlyingFetch(input, init);
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
                    callOptions.observeResponse?.({ headers: responseHeadersRecord });
                    settleHeaders();
                    const headers = new Headers(response.headers);
                    headers.set("content-type", "text/event-stream");
                    return new Response(
                        response.body === null ? null : inspectAnthropicSse(response.body),
                        {
                            status: response.status,
                            statusText: response.statusText,
                            headers,
                        },
                    );
                } catch (error) {
                    failHeaders(error);
                    throw error;
                }
            };

            let payloadError: unknown;
            let streamError: unknown;
            let content = "";
            let reasoning = "";
            let responseId: string | undefined;
            let responseModelId: string | undefined;
            let finishReason: ModelFinishReason = { unified: "other", raw: undefined };
            let usage: ModelUsage | undefined;
            const rawChunks: unknown[] = [];

            const recordChunk = (chunk: unknown): void => {
                rawChunks.push(chunk);
                callOptions.observeRawChunk?.(chunk);
            };

            const piContext = piContextFromPrompt(callOptions.prompt, "anthropic-messages", "anthropic", modelId);
            const piStream = streamAnthropic(buildPiModel(callOptions.headers), piContext, {
                apiKey: settings.apiKey ?? "plurnk-no-key",
                signal: callOptions.abortSignal,
                maxRetries: 0,
                fetch: customFetch,
                onPayload: (params) => {
                    if (!isRecord(params)) return;
                    try {
                        applyAnthropicPayloadOptions(params, callOptions, modelId, true);
                        capturedRequestBody = { ...params };
                    } catch (error) {
                        payloadError = error;
                        throw error;
                    }
                },
                onProviderStreamEvent: (event) => {
                    const rawEvent = originalEventsQueue.shift() ?? event;
                    recordChunk(rawEvent);
                    if (isRecord(rawEvent) && rawEvent.type === "message_start" && isRecord(rawEvent.message)) {
                        const id = typeof rawEvent.message.id === "string" ? rawEvent.message.id : undefined;
                        const mId = typeof rawEvent.message.model === "string" ? rawEvent.message.model : undefined;
                        if (id !== undefined) responseId ??= id;
                        if (mId !== undefined) responseModelId ??= mId;
                        callOptions.observeResponse?.({
                            ...(id === undefined ? {} : { id }),
                            ...(mId === undefined ? {} : { modelId: mId }),
                            ...(responseHeadersRecord === undefined ? {} : { headers: responseHeadersRecord }),
                        });
                    }
                },
            });

            const consumePromise = (async () => {
                for await (const event of piStream) {
                    if (event.type === "thinking_delta") {
                        reasoning += event.delta;
                        callOptions.observeReasoning?.(event.delta);
                    } else if (event.type === "text_delta") {
                        content += event.delta;
                        callOptions.observeText?.(event.delta);
                    } else if (event.type === "done" || event.type === "error") {
                        while (originalEventsQueue.length > 0) {
                            recordChunk(originalEventsQueue.shift());
                        }
                        if (sseErrorEvents.length > 0) {
                            for (const errEvt of sseErrorEvents) {
                                recordChunk(errEvt.rawEvent);
                                streamError ??= errEvt.error;
                            }
                            continue;
                        }
                        if (rawStreamReadError !== undefined) {
                            streamError ??= rawStreamReadError;
                            continue;
                        }
                        if (event.type === "done") {
                            const rawFinish = lastStopReason ?? event.message.rawStopReason;
                            const inputTok = lastUsage.input_tokens ?? event.message.usage.input;
                            const outputTok = lastUsage.output_tokens ?? event.message.usage.output;
                            const cacheRead = lastUsage.cache_read_input_tokens ?? event.message.usage.cacheRead;
                            const cacheWrite = lastUsage.cache_creation_input_tokens ?? event.message.usage.cacheWrite;
                            const inputTotal = inputTok + cacheRead + cacheWrite;
                            finishReason = {
                                unified: toUnifiedFinishReason(rawFinish),
                                raw: rawFinish,
                            };
                            usage = {
                                inputTokens: inputTotal,
                                outputTokens: outputTok,
                                totalTokens: inputTotal + outputTok,
                                inputTokenDetails: {
                                    noCacheTokens: inputTok,
                                    cacheReadTokens: cacheRead,
                                    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : undefined,
                                },
                                outputTokenDetails: {
                                    textTokens: outputTok,
                                    reasoningTokens: undefined,
                                },
                            };
                        } else {
                            const rawFinish = lastStopReason ?? event.error.rawStopReason;
                            const msg = event.error.errorMessage ?? "";
                            if (rawFinish !== undefined && msg.includes(rawFinish)) {
                                const inputTok = lastUsage.input_tokens ?? event.error.usage.input;
                                const outputTok = lastUsage.output_tokens ?? event.error.usage.output;
                                const cacheRead = lastUsage.cache_read_input_tokens ?? event.error.usage.cacheRead;
                                const cacheWrite = lastUsage.cache_creation_input_tokens ?? event.error.usage.cacheWrite;
                                const inputTotal = inputTok + cacheRead + cacheWrite;
                                finishReason = {
                                    unified: toUnifiedFinishReason(rawFinish),
                                    raw: rawFinish,
                                };
                                usage = {
                                    inputTokens: inputTotal,
                                    outputTokens: outputTok,
                                    totalTokens: inputTotal + outputTok,
                                    inputTokenDetails: {
                                        noCacheTokens: inputTok,
                                        cacheReadTokens: cacheRead,
                                        cacheWriteTokens: cacheWrite > 0 ? cacheWrite : undefined,
                                    },
                                    outputTokenDetails: {
                                        textTokens: outputTok,
                                        reasoningTokens: undefined,
                                    },
                                };
                            } else {
                                streamError ??= new Error(msg || "Anthropic stream error");
                            }
                        }
                    }
                }
            })();

            await Promise.race([
                headersReady,
                consumePromise.then(() => {
                    if (payloadError !== undefined) throw payloadError;
                }),
            ]);
            if (payloadError !== undefined) throw payloadError;
            await consumePromise;
            if (streamError !== undefined) throw streamError;
            return {
                content,
                reasoning,
                finishReason,
                usage,
                rawChunks,
                response: {
                    ...(responseId === undefined ? {} : { id: responseId }),
                    ...(responseModelId === undefined ? {} : { modelId: responseModelId }),
                    ...(responseHeadersRecord === undefined ? {} : { headers: responseHeadersRecord }),
                },
                warnings: [],
            };
        },
    };
};

const parseGoogleUsage = (usageMetadata: unknown): ModelUsage => {
    const meta = isRecord(usageMetadata) ? usageMetadata : undefined;
    const promptTokens = typeof meta?.promptTokenCount === "number" ? meta.promptTokenCount : 0;
    const candidateTokens = typeof meta?.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0;
    const thoughtsTokens = typeof meta?.thoughtsTokenCount === "number" ? meta.thoughtsTokenCount : undefined;
    const cachedTokens = typeof meta?.cachedContentTokenCount === "number" ? meta.cachedContentTokenCount : 0;
    const totalOut = candidateTokens + (thoughtsTokens ?? 0);
    return {
        inputTokens: promptTokens,
        outputTokens: totalOut,
        totalTokens: promptTokens + totalOut,
        inputTokenDetails: {
            noCacheTokens: promptTokens - cachedTokens,
            cacheReadTokens: cachedTokens,
            cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
            textTokens: candidateTokens,
            reasoningTokens: thoughtsTokens,
        },
    };
};

export const createGoogleModel = (
    modelId: string,
    settings: VendorTransportSettings = {},
): ModelTransport => {
    const resolvedBaseUrl = (settings.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const underlyingFetch = settings.fetch ?? outboundFetch;
    const cleanModelId = modelId.startsWith("models/") ? modelId.slice("models/".length) : modelId;

    const buildGoogleRequestBody = (callOptions: ModelTransportCallOptions): Record<string, unknown> => {
        const systemMessages = callOptions.prompt.filter(
            (m): m is Extract<ModelPromptMessage, { role: "system" }> => m.role === "system",
        );
        const conversation = callOptions.prompt.filter(
            (m): m is Exclude<ModelPromptMessage, { role: "system" }> => m.role !== "system",
        );
        const contents = conversation.map((msg) => {
            if (msg.role === "assistant") {
                return {
                    role: "model",
                    parts: msg.content
                        .filter((p): p is Extract<typeof msg.content[number], { type: "text" }> => p.type === "text")
                        .map((p) => ({ text: p.text })),
                };
            }
            const parts: unknown[] = [];
            for (const part of msg.content) {
                if (part.type === "text") {
                    parts.push({ text: part.text });
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
                parts.push({
                    inlineData: {
                        mimeType: part.mediaType,
                        data: base64,
                    },
                });
            }
            return { role: "user", parts };
        });

        const googleOpts = isRecord(callOptions.providerOptions?.google)
            ? callOptions.providerOptions.google
            : undefined;
        const thinkingConfigInput = isRecord(googleOpts?.thinkingConfig)
            ? { ...googleOpts.thinkingConfig }
            : {};
        if (callOptions.reasoning !== undefined && callOptions.reasoning !== "provider-default") {
            if (callOptions.reasoning === "none") {
                if (thinkingConfigInput.thinkingLevel === undefined && thinkingConfigInput.thinkingBudget === undefined) {
                    thinkingConfigInput.thinkingBudget = 0;
                }
            } else if (thinkingConfigInput.thinkingLevel === undefined && thinkingConfigInput.thinkingBudget === undefined) {
                thinkingConfigInput.thinkingLevel = callOptions.reasoning;
            }
        }

        const generationConfig: Record<string, unknown> = {
            ...(callOptions.maxOutputTokens !== undefined ? { maxOutputTokens: callOptions.maxOutputTokens } : {}),
            ...(callOptions.temperature !== undefined ? { temperature: callOptions.temperature } : {}),
            ...(callOptions.topP !== undefined ? { topP: callOptions.topP } : {}),
            ...(callOptions.topK !== undefined ? { topK: callOptions.topK } : {}),
            ...(callOptions.presencePenalty !== undefined ? { presencePenalty: callOptions.presencePenalty } : {}),
            ...(callOptions.frequencyPenalty !== undefined ? { frequencyPenalty: callOptions.frequencyPenalty } : {}),
            ...(callOptions.stopSequences !== undefined ? { stopSequences: callOptions.stopSequences } : {}),
            ...(callOptions.seed !== undefined ? { seed: callOptions.seed } : {}),
            ...(Object.keys(thinkingConfigInput).length > 0 ? { thinkingConfig: thinkingConfigInput } : {}),
        };

        const body: Record<string, unknown> = {
            ...(systemMessages.length > 0
                ? {
                    systemInstruction: {
                        parts: systemMessages.map((s) => ({ text: s.content })),
                    },
                }
                : {}),
            contents,
            ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
            ...(typeof googleOpts?.serviceTier === "string" ? { serviceTier: googleOpts.serviceTier } : {}),
            ...(typeof googleOpts?.cachedContent === "string" ? { cachedContent: googleOpts.cachedContent } : {}),
        };

        return withoutNativeTools(body, "generate-content");
    };

    const buildHeaders = (callHeaders?: Record<string, string | undefined>): Record<string, string> => {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            ...(settings.apiKey !== undefined ? { "x-goog-api-key": settings.apiKey } : {}),
            ...settings.headers,
        };
        if (callHeaders !== undefined) {
            for (const [k, v] of Object.entries(callHeaders)) {
                if (v !== undefined) headers[k] = v;
            }
        }
        return headers;
    };

    return {
        provider: "google.generative-ai",
        modelId,
        async execute(callOptions: ModelTransportCallOptions): Promise<ModelTransportResult> {
            callOptions.abortSignal?.throwIfAborted();
            const requestBody = buildGoogleRequestBody(callOptions);
            if (!callOptions.streaming) {
                const url = `${resolvedBaseUrl}/models/${cleanModelId}:generateContent`;
                const response = await underlyingFetch(url, {
                    method: "POST",
                    headers: buildHeaders(callOptions.headers),
                    body: JSON.stringify(requestBody),
                    signal: callOptions.abortSignal,
                });
                const responseHeaders = headersToRecord(response.headers);
                if (!response.ok) {
                    const text = await response.text().catch(() => "");
                    const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                    throw new APICallError({
                        message,
                        url,
                        requestBodyValues: requestBody,
                        statusCode: response.status,
                        responseHeaders,
                        responseBody: text,
                        isRetryable: isResponseRetryable(response.status, response.headers),
                        data,
                    });
                }
                const text = await response.text();
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch (cause) {
                    throw new APICallError({
                        message: "Failed to process successful response",
                        url,
                        requestBodyValues: requestBody,
                        statusCode: response.status,
                        responseHeaders,
                        responseBody: text,
                        cause: new JSONParseError({ text, cause }),
                        isRetryable: isResponseRetryable(response.status, response.headers),
                    });
                }
                if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
                    throw new APICallError({
                        message: "Failed to process successful response",
                        url,
                        requestBodyValues: requestBody,
                        statusCode: response.status,
                        responseHeaders,
                        responseBody: text,
                        cause: new TypeValidationError({
                            value: parsed,
                            cause: new Error("Expected candidates array in Google generateContent response"),
                        }),
                        isRetryable: isResponseRetryable(response.status, response.headers),
                    });
                }
                const candidate = isRecord(parsed.candidates[0]) ? parsed.candidates[0] : undefined;
                const parts = isRecord(candidate?.content) && Array.isArray(candidate.content.parts)
                    ? candidate.content.parts
                    : [];
                let content = "";
                let reasoning = "";
                let nativeToolCalls = false;
                for (const part of parts) {
                    if (!isRecord(part)) continue;
                    if (part.thought === true && typeof part.text === "string") {
                        reasoning += part.text;
                    } else if (typeof part.text === "string") {
                        content += part.text;
                    } else if (isRecord(part.functionCall)) {
                        nativeToolCalls = true;
                    }
                }
                const rawFinish = typeof candidate?.finishReason === "string"
                    ? candidate.finishReason
                    : "STOP";
                return {
                    content,
                    reasoning,
                    ...(nativeToolCalls ? { nativeToolCalls: true } : {}),
                    finishReason: {
                        unified: toUnifiedFinishReason(rawFinish),
                        raw: rawFinish,
                    },
                    usage: parseGoogleUsage(parsed.usageMetadata),
                    rawChunks: [],
                    response: {
                        id: typeof parsed.responseId === "string" ? parsed.responseId : undefined,
                        modelId: typeof parsed.modelVersion === "string" ? parsed.modelVersion : modelId,
                        headers: responseHeaders,
                        body: parsed,
                    },
                    warnings: [],
                };
            }

            const url = `${resolvedBaseUrl}/models/${cleanModelId}:streamGenerateContent?alt=sse`;
            const response = await underlyingFetch(url, {
                method: "POST",
                headers: buildHeaders(callOptions.headers),
                body: JSON.stringify(requestBody),
                signal: callOptions.abortSignal,
            });
            const responseHeaders = headersToRecord(response.headers);
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                throw new APICallError({
                    message,
                    url,
                    requestBodyValues: requestBody,
                    statusCode: response.status,
                    responseHeaders,
                    responseBody: text,
                    isRetryable: isResponseRetryable(response.status, response.headers),
                    data,
                });
            }
            callOptions.observeResponse?.({ headers: responseHeaders });

            const bodyStream = response.body;
            let lastFinishReason = "STOP";
            let lastUsage: ModelUsage = parseGoogleUsage(undefined);
            let emittedMeta = false;
            let responseId: string | undefined;
            let responseModelId: string | undefined;
            let content = "";
            let reasoning = "";
            const rawChunks: unknown[] = [];

            const processParsedChunk = (parsed: Record<string, unknown>): void => {
                rawChunks.push(parsed);
                callOptions.observeRawChunk?.(parsed);
                if (!emittedMeta) {
                    const id = typeof parsed.responseId === "string" ? parsed.responseId : undefined;
                    const mId = typeof parsed.modelVersion === "string" ? parsed.modelVersion : undefined;
                    if (id !== undefined || mId !== undefined) {
                        emittedMeta = true;
                        if (id !== undefined) responseId ??= id;
                        if (mId !== undefined) responseModelId ??= mId;
                        callOptions.observeResponse?.({
                            ...(id === undefined ? {} : { id }),
                            ...(mId === undefined ? {} : { modelId: mId }),
                            headers: responseHeaders,
                        });
                    }
                }
                if (isRecord(parsed.usageMetadata)) {
                    lastUsage = parseGoogleUsage(parsed.usageMetadata);
                }
                if (Array.isArray(parsed.candidates) && isRecord(parsed.candidates[0])) {
                    const cand = parsed.candidates[0];
                    if (typeof cand.finishReason === "string") {
                        lastFinishReason = cand.finishReason;
                    }
                    const parts = isRecord(cand.content) && Array.isArray(cand.content.parts)
                        ? cand.content.parts
                        : [];
                    for (const part of parts) {
                        if (!isRecord(part)) continue;
                        if (part.thought === true && typeof part.text === "string" && part.text.length > 0) {
                            reasoning += part.text;
                            callOptions.observeReasoning?.(part.text);
                        } else if (typeof part.text === "string" && part.text.length > 0) {
                            content += part.text;
                            callOptions.observeText?.(part.text);
                        }
                    }
                }
            };

            if (bodyStream !== null) {
                const reader = bodyStream.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                const parseBlock = (block: string): void => {
                    const lines = block.split(/\r?\n/);
                    const dataLines: string[] = [];
                    for (const line of lines) {
                        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
                    }
                    if (dataLines.length === 0) return;
                    const data = dataLines.join("\n").trim();
                    if (data === "[DONE]" || data.length === 0) return;
                    try {
                        const parsed: unknown = JSON.parse(data);
                        if (isRecord(parsed)) processParsedChunk(parsed);
                    } catch {
                        // Ignore malformed frame
                    }
                };
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            buffer += decoder.decode();
                            break;
                        }
                        buffer += decoder.decode(value, { stream: true });
                        while (true) {
                            const match = buffer.match(/\r?\n\r?\n/);
                            if (match?.index === undefined) break;
                            const block = buffer.slice(0, match.index);
                            buffer = buffer.slice(match.index + match[0].length);
                            parseBlock(block);
                        }
                    }
                    if (buffer.trim().length > 0) {
                        parseBlock(buffer);
                    }
                } finally {
                    reader.releaseLock();
                }
            }

            return {
                content,
                reasoning,
                finishReason: {
                    unified: toUnifiedFinishReason(lastFinishReason),
                    raw: lastFinishReason,
                },
                usage: lastUsage,
                rawChunks,
                response: {
                    ...(responseId === undefined ? {} : { id: responseId }),
                    ...(responseModelId === undefined ? {} : { modelId: responseModelId }),
                    headers: responseHeaders,
                },
                warnings: [],
            };
        },
    };
};

type AmazonBedrockSettings = {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    apiKey?: string;
    baseURL?: string;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
};

export const createAmazonBedrockModel = (
    modelId: string,
    settings: AmazonBedrockSettings = {},
): ModelTransport => {
    const region = settings.region ?? "us-east-1";
    const resolvedBaseUrl = (settings.baseURL ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(/\/+$/, "");
    const underlyingFetch = settings.fetch ?? outboundFetch;

    const buildBedrockBody = (callOptions: ModelTransportCallOptions): Record<string, unknown> => {
        const systemMessages = callOptions.prompt.filter(
            (m): m is Extract<ModelPromptMessage, { role: "system" }> => m.role === "system",
        );
        const conversation = callOptions.prompt.filter(
            (m): m is Exclude<ModelPromptMessage, { role: "system" }> => m.role !== "system",
        );
        const messages = conversation.map((msg) => {
            if (msg.role === "assistant") {
                return {
                    role: "assistant",
                    content: msg.content
                        .filter((p): p is Extract<typeof msg.content[number], { type: "text" }> => p.type === "text")
                        .map((p) => ({ text: p.text })),
                };
            }
            const content: unknown[] = [];
            for (const part of msg.content) {
                if (part.type === "text") {
                    content.push({ text: part.text });
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
                const format = part.mediaType.split("/")[1] ?? "png";
                if (part.mediaType.startsWith("image/")) {
                    content.push({
                        image: {
                            format,
                            source: { bytes: base64 },
                        },
                    });
                }
            }
            return { role: "user", content };
        });

        const bedrockOpts = isRecord(callOptions.providerOptions?.bedrock)
            ? callOptions.providerOptions.bedrock
            : undefined;
        const reasoningCfg = isRecord(bedrockOpts?.reasoningConfig)
            ? bedrockOpts.reasoningConfig
            : undefined;
        const budgetTokens = typeof reasoningCfg?.budgetTokens === "number"
            ? reasoningCfg.budgetTokens
            : undefined;
        const baseMaxTokens = callOptions.maxOutputTokens;
        const maxTokens = baseMaxTokens !== undefined
            ? (budgetTokens !== undefined ? baseMaxTokens + budgetTokens : baseMaxTokens)
            : undefined;

        const inferenceConfig: Record<string, unknown> = {
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(callOptions.temperature !== undefined ? { temperature: callOptions.temperature } : {}),
            ...(callOptions.topP !== undefined ? { topP: callOptions.topP } : {}),
            ...(callOptions.stopSequences !== undefined ? { stopSequences: callOptions.stopSequences } : {}),
        };

        const additionalModelRequestFields: Record<string, unknown> = {
            ...(isRecord(bedrockOpts?.additionalModelRequestFields)
                ? bedrockOpts.additionalModelRequestFields
                : {}),
        };
        if (reasoningCfg !== undefined) {
            if (reasoningCfg.type === "adaptive") {
                additionalModelRequestFields.thinking = { type: "adaptive" };
            } else if (reasoningCfg.type === "enabled" && budgetTokens !== undefined) {
                additionalModelRequestFields.thinking = { type: "enabled", budget_tokens: budgetTokens };
            }
        }
        const maxReasoningEffort = typeof reasoningCfg?.maxReasoningEffort === "string"
            ? reasoningCfg.maxReasoningEffort
            : callOptions.reasoning !== undefined
                && callOptions.reasoning !== "none"
                && callOptions.reasoning !== "provider-default"
                ? callOptions.reasoning
                : undefined;
        if (maxReasoningEffort !== undefined) {
            additionalModelRequestFields.output_config = {
                ...(isRecord(additionalModelRequestFields.output_config) ? additionalModelRequestFields.output_config : {}),
                effort: maxReasoningEffort,
            };
        }

        return {
            ...(systemMessages.length > 0
                ? { system: systemMessages.map((s) => ({ text: s.content })) }
                : {}),
            messages,
            ...(Object.keys(inferenceConfig).length > 0 ? { inferenceConfig } : {}),
            ...(Object.keys(additionalModelRequestFields).length > 0 ? { additionalModelRequestFields } : {}),
            ...(typeof bedrockOpts?.serviceTier === "string"
                ? { serviceTier: { type: bedrockOpts.serviceTier } }
                : {}),
        };
    };

    const dispatchBedrockFetch = async (
        url: string,
        bodyStr: string,
        callOptions: ModelTransportCallOptions,
    ): Promise<Response> => {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            ...(settings.apiKey !== undefined && settings.apiKey.length > 0
                ? { Authorization: `Bearer ${settings.apiKey}` }
                : {}),
            ...settings.headers,
        };
        if (callOptions.headers !== undefined) {
            for (const [k, v] of Object.entries(callOptions.headers)) {
                if (v !== undefined) headers[k] = v;
            }
        }
        return underlyingFetch(url, {
            method: "POST",
            headers,
            body: bodyStr,
            signal: callOptions.abortSignal,
        });
    };

    return {
        provider: "amazon-bedrock.converse",
        modelId,
        async execute(callOptions: ModelTransportCallOptions): Promise<ModelTransportResult> {
            callOptions.abortSignal?.throwIfAborted();
            const requestBody = buildBedrockBody(callOptions);
            const url = `${resolvedBaseUrl}/model/${encodeURIComponent(modelId)}/converse`;
            const response = await dispatchBedrockFetch(url, JSON.stringify(requestBody), callOptions);
            const responseHeaders = headersToRecord(response.headers);
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                throw new APICallError({
                    message,
                    url,
                    requestBodyValues: requestBody,
                    statusCode: response.status,
                    responseHeaders,
                    responseBody: text,
                    isRetryable: isResponseRetryable(response.status, response.headers),
                    data,
                });
            }
            const text = await response.text();
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch (cause) {
                throw new APICallError({
                    message: "Failed to process successful response",
                    url,
                    requestBodyValues: requestBody,
                    statusCode: response.status,
                    responseHeaders,
                    responseBody: text,
                    cause: new JSONParseError({ text, cause }),
                    isRetryable: isResponseRetryable(response.status, response.headers),
                });
            }
            if (!isRecord(parsed)) {
                throw new APICallError({
                    message: "Failed to process successful response",
                    url,
                    requestBodyValues: requestBody,
                    statusCode: response.status,
                    responseHeaders,
                    responseBody: text,
                    cause: new TypeValidationError({
                        value: parsed,
                        cause: new Error("Expected JSON object from Bedrock converse"),
                    }),
                    isRetryable: isResponseRetryable(response.status, response.headers),
                });
            }
            const msgContent = isRecord(parsed.output) && isRecord(parsed.output.message) && Array.isArray(parsed.output.message.content)
                ? parsed.output.message.content
                : [];
            let content = "";
            let reasoning = "";
            let nativeToolCalls = false;
            for (const block of msgContent) {
                if (!isRecord(block)) continue;
                if (typeof block.text === "string") {
                    content += block.text;
                } else if (isRecord(block.reasoningContent) && isRecord(block.reasoningContent.reasoningText) && typeof block.reasoningContent.reasoningText.text === "string") {
                    reasoning += block.reasoningContent.reasoningText.text;
                } else if (isRecord(block.toolUse)) {
                    nativeToolCalls = true;
                }
            }
            if (callOptions.streaming) {
                callOptions.observeResponse?.({ headers: responseHeaders, modelId });
                if (reasoning.length > 0) callOptions.observeReasoning?.(reasoning);
                if (content.length > 0) callOptions.observeText?.(content);
            }
            const usageObj = isRecord(parsed.usage) ? parsed.usage : undefined;
            const inputTokens = typeof usageObj?.inputTokens === "number" ? usageObj.inputTokens : undefined;
            const outputTokens = typeof usageObj?.outputTokens === "number" ? usageObj.outputTokens : undefined;
            const cacheRead = typeof usageObj?.cacheReadInputTokens === "number" ? usageObj.cacheReadInputTokens : undefined;
            const cacheWrite = typeof usageObj?.cacheWriteInputTokens === "number" ? usageObj.cacheWriteInputTokens : undefined;
            const rawStop = typeof parsed.stopReason === "string" ? parsed.stopReason : "end_turn";
            return {
                content,
                reasoning,
                ...(nativeToolCalls ? { nativeToolCalls: true } : {}),
                finishReason: {
                    unified: toUnifiedFinishReason(rawStop),
                    raw: rawStop,
                },
                usage: {
                    inputTokens,
                    outputTokens,
                    totalTokens: inputTokens !== undefined && outputTokens !== undefined
                        ? inputTokens + outputTokens
                        : undefined,
                    inputTokenDetails: {
                        noCacheTokens: inputTokens !== undefined
                            ? inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0)
                            : undefined,
                        cacheReadTokens: cacheRead,
                        cacheWriteTokens: cacheWrite,
                    },
                    outputTokenDetails: {
                        textTokens: outputTokens,
                        reasoningTokens: undefined,
                    },
                },
                rawChunks: [],
                response: {
                    modelId,
                    headers: responseHeaders,
                    ...(callOptions.streaming ? {} : { body: parsed }),
                },
                warnings: [],
            };
        },
    };
};
