import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { outboundFetch } from "@plurnk/plurnk-meta";
import {
    isProviderCredentialName,
    lookupProvider,
    providerCatalogSnapshot,
    type ProviderInfo,
} from "@plurnk/plurnk-models";
import {
    isRecord,
    Validator,
    type ModelReadiness,
    type ModelReadinessCause,
} from "@plurnk/plurnk-contracts";
import { providerSetting, providerEnvPrefix as envPrefix } from "./provider-env.ts";
import { providerModelOptions } from "./model-options.ts";
import {
    createOpenAICompatible,
    encodeBytesBase64,
    extractErrorMessage,
    headersToRecord,
    isResponseRetryable,
    toUnifiedFinishReason,
    type LanguageModelSource,
    type OpenAICompatibleProvider,
} from "./aiSdkTransport.ts";
import { APICallError, JSONParseError, TypeValidationError } from "./errors.ts";
import { providerCostNormalizer } from "./accounting.ts";
import type { AiSdkProviderOptions, CacheAffinity, NativeRequestControls } from "./AiSdkProvider.ts";
import type {
    LanguageModel,
    LanguageModelCallOptions,
    LanguageModelContentPart,
    LanguageModelGenerateResult,
    LanguageModelPromptMessage,
    LanguageModelStreamPart,
    LanguageModelStreamResult,
    LanguageModelV4Usage,
    ProviderCostNormalizer,
} from "./types.ts";
import { cacheAffinityDeclarationFromEnv } from "./env.ts";
import { withoutNativeTools, withoutNativeToolsFetch } from "./native-tools.ts";

export type SdkProviderSettings = {
    apiKey?: string;
    baseURL?: string;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
    appUrl?: string;
    appName?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
};

export const createOpenAI = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider =>
    createOpenAICompatible({
        name: "openai",
        namespace: "openai",
        baseURL: settings.baseURL ?? "https://api.openai.com/v1",
        apiKey: settings.apiKey,
        headers: settings.headers,
        fetch: settings.fetch,
        includeTopK: false,
    });

export const createGroq = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider =>
    createOpenAICompatible({
        name: "groq",
        namespace: "groq",
        baseURL: settings.baseURL ?? "https://api.groq.com/openai/v1",
        apiKey: settings.apiKey,
        headers: settings.headers,
        fetch: settings.fetch,
    });

export const createCerebras = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider =>
    createOpenAICompatible({
        name: "cerebras",
        namespace: "cerebras",
        baseURL: settings.baseURL ?? "https://api.cerebras.ai/v1",
        apiKey: settings.apiKey,
        headers: settings.headers,
        fetch: settings.fetch,
    });

export const createMistral = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider =>
    createOpenAICompatible({
        name: "mistral",
        namespace: "mistral",
        baseURL: settings.baseURL ?? "https://api.mistral.ai/v1",
        apiKey: settings.apiKey,
        headers: settings.headers,
        fetch: settings.fetch,
        includeUsage: false,
    });

export const createTogetherAI = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider =>
    createOpenAICompatible({
        name: "togetherai",
        namespace: "togetherai",
        baseURL: settings.baseURL ?? "https://api.together.xyz/v1",
        apiKey: settings.apiKey,
        headers: settings.headers,
        fetch: settings.fetch,
    });

export const createDeepInfra = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider =>
    createOpenAICompatible({
        name: "deepinfra",
        namespace: "deepinfra",
        baseURL: settings.baseURL ?? "https://api.deepinfra.com/v1/openai",
        apiKey: settings.apiKey,
        headers: settings.headers,
        fetch: settings.fetch,
    });

export const createOpenRouter = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider => {
    const headers: Record<string, string> = {
        ...settings.headers,
        ...(settings.appUrl === undefined ? {} : { "HTTP-Referer": settings.appUrl }),
        ...(settings.appName === undefined ? {} : { "X-OpenRouter-Title": settings.appName }),
    };
    return createOpenAICompatible({
        name: "openrouter",
        namespace: "openrouter",
        baseURL: settings.baseURL ?? "https://openrouter.ai/api/v1",
        apiKey: settings.apiKey,
        headers,
        fetch: settings.fetch,
    });
};

export const createXai = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider => {
    const resolvedBaseUrl = (settings.baseURL ?? "https://api.x.ai/v1").replace(/\/+$/, "");
    const endpointUrl = `${resolvedBaseUrl}/responses`;

    const makeLanguageModel = (modelId: string): LanguageModel => {
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

        const dummyContext = normalizeContext({
            messages: [{ role: "user", content: "", timestamp: 0 }],
        });

        const applyResponsesPayload = (
            payload: Record<string, unknown>,
            callOptions: LanguageModelCallOptions,
            streaming: boolean,
        ): void => {
            payload.model = modelId;
            delete payload.store;
            const inputItems: unknown[] = [];
            for (const msg of callOptions.prompt) {
                if (msg.role === "system") {
                    inputItems.push({ role: "system", content: msg.content });
                } else if (msg.role === "assistant") {
                    const text = msg.content
                        .filter((p): p is Extract<typeof msg.content[number], { type: "text" }> => p.type === "text")
                        .map((p) => p.text)
                        .join("");
                    inputItems.push({ role: "assistant", content: text });
                } else {
                    const contentParts: unknown[] = [];
                    for (const part of msg.content) {
                        if (part.type === "text") {
                            contentParts.push({ type: "input_text", text: part.text });
                        } else if (part.mediaType.startsWith("image/")) {
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
                            contentParts.push({
                                type: "input_image",
                                detail: "auto",
                                image_url: `data:${part.mediaType};base64,${base64}`,
                            });
                        } else {
                            throw new APICallError({
                                message: `Unsupported file media type for xAI responses: ${part.mediaType}`,
                                url: endpointUrl,
                                requestBodyValues: {},
                                statusCode: 400,
                                isRetryable: false,
                            });
                        }
                    }
                    inputItems.push({ role: "user", content: contentParts });
                }
            }
            payload.input = inputItems;
            if (callOptions.maxOutputTokens !== undefined) payload.max_output_tokens = callOptions.maxOutputTokens;
            else delete payload.max_output_tokens;
            if (callOptions.temperature !== undefined) payload.temperature = callOptions.temperature;
            else delete payload.temperature;
            if (callOptions.topP !== undefined) payload.top_p = callOptions.topP;
            if (callOptions.reasoning !== undefined && callOptions.reasoning !== "none" && callOptions.reasoning !== "provider-default") {
                payload.reasoning = { effort: callOptions.reasoning };
            } else {
                delete payload.reasoning;
            }
            const xaiOpts = isRecord(callOptions.providerOptions?.xai) ? callOptions.providerOptions.xai : undefined;
            if (xaiOpts !== undefined) {
                for (const [k, v] of Object.entries(xaiOpts)) {
                    if (v === undefined) continue;
                    if (k === "serviceTier") payload.service_tier = v;
                    else if (k === "reasoningEffort") payload.reasoning = { ...(isRecord(payload.reasoning) ? payload.reasoning : {}), effort: v };
                    else payload[k] = v;
                }
            }
            const cleaned = withoutNativeTools({ ...payload }, "openai");
            for (const key of Object.keys(payload)) delete payload[key];
            Object.assign(payload, cleaned);
            if (!streaming) delete payload.stream;
            else payload.stream = true;
        };

        return {
            specificationVersion: "v4",
            provider: "xai.responses",
            modelId,
            supportedUrls: {},
            async doGenerate(callOptions: LanguageModelCallOptions): Promise<LanguageModelGenerateResult> {
                callOptions.abortSignal?.throwIfAborted();
                const fetchFn = settings.fetch ?? outboundFetch;
                let capturedRequestBody: unknown = {};
                let rawResponseBody: Record<string, unknown> | undefined;
                let responseHeadersRecord: Record<string, string> | undefined;
                let settleHeaders!: () => void;
                let failHeaders!: (err: unknown) => void;
                const headersReady = new Promise<void>((resolve, reject) => {
                    settleHeaders = resolve;
                    failHeaders = reject;
                });

                const customFetch: typeof globalThis.fetch = async (input, init) => {
                    try {
                        let strippedInit = init;
                        if (init !== undefined && typeof init.body === "string") {
                            try {
                                const parsedBody: unknown = JSON.parse(init.body);
                                if (isRecord(parsedBody)) {
                                    delete parsedBody.stream;
                                    strippedInit = { ...init, body: JSON.stringify(parsedBody) };
                                }
                            } catch {
                                // Leave body as-is.
                            }
                        }
                        const response = await fetchFn(input, strippedInit);
                        responseHeadersRecord = headersToRecord(response.headers);
                        if (!response.ok) {
                            const text = await response.text().catch(() => "");
                            const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                            const apiError = new APICallError({
                                message,
                                url: endpointUrl,
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
                        const text = await response.text();
                        const parsed: unknown = JSON.parse(text);
                        if (!isRecord(parsed)) {
                            const apiError = new APICallError({
                                message: "Failed to process successful response",
                                url: endpointUrl,
                                requestBodyValues: capturedRequestBody,
                                statusCode: response.status,
                                responseHeaders: responseHeadersRecord,
                                responseBody: text,
                                isRetryable: false,
                            });
                            failHeaders(apiError);
                            throw apiError;
                        }
                        rawResponseBody = parsed;
                        settleHeaders();
                        const completedEvent = { type: "response.completed", response: parsed };
                        return new Response(`data: ${JSON.stringify(completedEvent)}\n\ndata: [DONE]\n\n`, {
                            status: 200,
                            headers: { "content-type": "text/event-stream" },
                        });
                    } catch (error) {
                        failHeaders(error);
                        throw error;
                    }
                };

                let payloadError: unknown;
                const piStream = streamOpenAIResponses(buildPiModel(callOptions.headers), dummyContext, {
                    apiKey: settings.apiKey ?? "plurnk-no-key",
                    signal: callOptions.abortSignal,
                    fetch: customFetch,
                    onPayload: (params) => {
                        if (!isRecord(params)) return;
                        try {
                            applyResponsesPayload(params, callOptions, false);
                            capturedRequestBody = { ...params };
                            params.stream = true;
                        } catch (err) {
                            payloadError = err;
                            throw err;
                        }
                    },
                });
                const resultPromise = piStream.result();
                await Promise.race([
                    headersReady,
                    resultPromise.then(() => {
                        if (payloadError !== undefined) throw payloadError;
                    }),
                ]);
                if (payloadError !== undefined) throw payloadError;
                await resultPromise;
                const content: LanguageModelContentPart[] = [];
                if (Array.isArray(rawResponseBody?.output)) {
                    for (const item of rawResponseBody.output) {
                        if (!isRecord(item)) continue;
                        if (item.type === "reasoning" && Array.isArray(item.summary)) {
                            for (const s of item.summary) {
                                if (isRecord(s) && typeof s.text === "string") {
                                    content.push({ type: "reasoning", text: s.text });
                                }
                            }
                        } else if (item.type === "message" && Array.isArray(item.content)) {
                            for (const c of item.content) {
                                if (isRecord(c) && typeof c.text === "string") {
                                    content.push({ type: "text", text: c.text });
                                }
                            }
                        }
                    }
                }
                const usageObj = isRecord(rawResponseBody?.usage) ? rawResponseBody.usage : undefined;
                const inputTotal = typeof usageObj?.input_tokens === "number"
                    ? usageObj.input_tokens
                    : typeof usageObj?.prompt_tokens === "number" ? usageObj.prompt_tokens : undefined;
                const outputTotal = typeof usageObj?.output_tokens === "number"
                    ? usageObj.output_tokens
                    : typeof usageObj?.completion_tokens === "number" ? usageObj.completion_tokens : undefined;
                return {
                    content,
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                        inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead: undefined, cacheWrite: undefined },
                        outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
                    },
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
                const fetchFn = settings.fetch ?? outboundFetch;
                let capturedRequestBody: unknown = {};
                let responseHeadersRecord: Record<string, string> | undefined;
                let settleHeaders!: () => void;
                let failHeaders!: (err: unknown) => void;
                const headersReady = new Promise<void>((resolve, reject) => {
                    settleHeaders = resolve;
                    failHeaders = reject;
                });

                const customFetch: typeof globalThis.fetch = async (input, init) => {
                    try {
                        const response = await fetchFn(input, init);
                        responseHeadersRecord = headersToRecord(response.headers);
                        if (!response.ok) {
                            const text = await response.text().catch(() => "");
                            const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                            const apiError = new APICallError({
                                message,
                                url: endpointUrl,
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
                        return response;
                    } catch (error) {
                        failHeaders(error);
                        throw error;
                    }
                };

                let streamController!: ReadableStreamDefaultController<LanguageModelStreamPart>;
                let streamClosed = false;
                const safeEnqueue = (part: LanguageModelStreamPart): void => {
                    if (!streamClosed) streamController.enqueue(part);
                };
                const safeClose = (): void => {
                    if (!streamClosed) {
                        streamClosed = true;
                        streamController.close();
                    }
                };
                const stream = new ReadableStream<LanguageModelStreamPart>({
                    start(controller) {
                        streamController = controller;
                        controller.enqueue({ type: "stream-start", warnings: [] });
                    },
                });

                let payloadError: unknown;
                const piStream = streamOpenAIResponses(buildPiModel(callOptions.headers), dummyContext, {
                    apiKey: settings.apiKey ?? "plurnk-no-key",
                    signal: callOptions.abortSignal,
                    fetch: customFetch,
                    onPayload: (params) => {
                        if (!isRecord(params)) return;
                        try {
                            applyResponsesPayload(params, callOptions, true);
                            capturedRequestBody = { ...params };
                        } catch (err) {
                            payloadError = err;
                            throw err;
                        }
                    },
                    onProviderStreamEvent: (event) => {
                        safeEnqueue({ type: "raw", rawValue: event });
                    },
                });

                const originalPush = piStream.push.bind(piStream);
                piStream.push = (event: AssistantMessageEvent): void => {
                    if (event.type === "thinking_delta") {
                        safeEnqueue({ type: "reasoning-delta", id: `reasoning-${event.contentIndex}`, delta: event.delta });
                    } else if (event.type === "text_delta") {
                        safeEnqueue({ type: "text-delta", id: `text-${event.contentIndex}`, delta: event.delta });
                    } else if (event.type === "done" || event.type === "error") {
                        if (event.type === "done") {
                            const u = event.message.usage;
                            safeEnqueue({
                                type: "finish",
                                finishReason: {
                                    unified: toUnifiedFinishReason(event.message.rawStopReason ?? "stop"),
                                    raw: event.message.rawStopReason ?? "stop",
                                },
                                usage: {
                                    inputTokens: { total: u.input + u.cacheRead + u.cacheWrite, noCache: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
                                    outputTokens: { total: u.output, text: u.output, reasoning: undefined },
                                },
                            });
                        } else {
                            safeEnqueue({ type: "error", error: new Error(event.error.errorMessage ?? "xAI stream error") });
                        }
                        safeClose();
                    }
                    originalPush(event);
                };

                const resultPromise = piStream.result();
                await Promise.race([
                    headersReady,
                    resultPromise.then(() => {
                        if (payloadError !== undefined) throw payloadError;
                    }),
                ]);
                if (payloadError !== undefined) throw payloadError;
                return {
                    stream,
                    response: { ...(responseHeadersRecord === undefined ? {} : { headers: responseHeadersRecord }) },
                };
            },
        };
    };

    return Object.assign(
        (modelId: string) => makeLanguageModel(modelId),
        { languageModel: makeLanguageModel, chat: makeLanguageModel },
    );
};

export const createAnthropic = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider => {
    const resolvedBaseUrl = (settings.baseURL ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    const endpointUrl = `${resolvedBaseUrl}/messages`;

    const makeLanguageModel = (modelId: string): LanguageModel => {
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
                baseUrl: "https://anthropic.plurnk.internal",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 16384,
                headers: mergedHeaders,
            };
        };

        const dummyContext = normalizeContext({
            messages: [{ role: "user", content: "", timestamp: 0 }],
        });

        const applyAnthropicPayload = (
            payload: Record<string, unknown>,
            callOptions: LanguageModelCallOptions,
            streaming: boolean,
        ): void => {
            payload.model = modelId;
            payload.max_tokens = callOptions.maxOutputTokens ?? 4096;
            const systemMessages = callOptions.prompt.filter(
                (m): m is Extract<LanguageModelPromptMessage, { role: "system" }> => m.role === "system",
            );
            if (systemMessages.length > 0) {
                payload.system = systemMessages.map((m) => {
                    const anthOpts = isRecord(m.providerOptions?.anthropic) ? m.providerOptions.anthropic : undefined;
                    const cacheControl = anthOpts?.cacheControl;
                    return {
                        type: "text",
                        text: m.content,
                        ...(isRecord(cacheControl) ? { cache_control: cacheControl } : {}),
                    };
                });
            } else {
                delete payload.system;
            }

            const convMessages = callOptions.prompt.filter(
                (m): m is Exclude<LanguageModelPromptMessage, { role: "system" }> => m.role !== "system",
            );
            payload.messages = convMessages.map((m) => {
                if (m.role === "assistant") {
                    return {
                        role: "assistant",
                        content: m.content
                            .filter((p): p is Extract<typeof m.content[number], { type: "text" }> => p.type === "text")
                            .map((p) => ({ type: "text", text: p.text })),
                    };
                }
                return {
                    role: "user",
                    content: m.content.map((p) => {
                        if (p.type === "text") return { type: "text", text: p.text };
                        const rawBytes = p.data instanceof Uint8Array
                            ? p.data
                            : isRecord(p.data) && p.data.data instanceof Uint8Array
                                ? p.data.data
                                : undefined;
                        const base64 = rawBytes !== undefined
                            ? encodeBytesBase64(rawBytes)
                            : typeof p.data === "string"
                                ? p.data
                                : isRecord(p.data) && typeof p.data.data === "string"
                                    ? p.data.data
                                    : "";
                        if (p.mediaType.startsWith("image/")) {
                            return {
                                type: "image",
                                source: { type: "base64", media_type: p.mediaType, data: base64 },
                            };
                        }
                        if (p.mediaType === "application/pdf") {
                            return {
                                type: "document",
                                source: { type: "base64", media_type: p.mediaType, data: base64 },
                            };
                        }
                        throw new APICallError({
                            message: `Unsupported file media type for Anthropic messages: ${p.mediaType}`,
                            url: endpointUrl,
                            requestBodyValues: {},
                            statusCode: 400,
                            isRetryable: false,
                        });
                    }),
                };
            });

            if (callOptions.temperature !== undefined) payload.temperature = callOptions.temperature;
            else delete payload.temperature;
            if (callOptions.topP !== undefined) payload.top_p = callOptions.topP;
            else delete payload.top_p;
            if (callOptions.topK !== undefined) payload.top_k = callOptions.topK;
            else delete payload.top_k;
            if (callOptions.stopSequences !== undefined) payload.stop_sequences = callOptions.stopSequences;
            else delete payload.stop_sequences;

            delete payload.thinking;
            delete payload.output_config;
            const anthOpts = isRecord(callOptions.providerOptions?.anthropic)
                ? callOptions.providerOptions.anthropic
                : undefined;
            if (anthOpts !== undefined) {
                for (const [key, value] of Object.entries(anthOpts)) {
                    if (value === undefined) continue;
                    if (key === "thinking" && isRecord(value)) {
                        const thinking: Record<string, unknown> = { ...value };
                        if (thinking.budgetTokens !== undefined) {
                            thinking.budget_tokens = thinking.budgetTokens;
                            delete thinking.budgetTokens;
                        }
                        payload.thinking = thinking;
                    } else if (key === "serviceTier") {
                        payload.service_tier = value;
                    } else if (key === "effort") {
                        payload.output_config = {
                            ...(isRecord(payload.output_config) ? payload.output_config : {}),
                            effort: value,
                        };
                    } else {
                        payload[key] = value;
                    }
                }
            }

            const cleaned = withoutNativeTools({ ...payload }, "messages");
            for (const key of Object.keys(payload)) delete payload[key];
            Object.assign(payload, cleaned);
            if (!streaming) delete payload.stream;
            else payload.stream = true;
        };

        return {
            specificationVersion: "v4",
            provider: "anthropic.messages",
            modelId,
            supportedUrls: {},
            async doGenerate(callOptions: LanguageModelCallOptions): Promise<LanguageModelGenerateResult> {
                callOptions.abortSignal?.throwIfAborted();
                const fetchFn = settings.fetch ?? outboundFetch;
                let capturedRequestBody: unknown = {};
                let rawResponseBody: Record<string, unknown> | undefined;
                let responseHeadersRecord: Record<string, string> | undefined;
                let settleHeaders!: () => void;
                let failHeaders!: (err: unknown) => void;
                const headersReady = new Promise<void>((resolve, reject) => {
                    settleHeaders = resolve;
                    failHeaders = reject;
                });

                const customFetch: typeof globalThis.fetch = async (_input, init) => {
                    try {
                        let strippedInit = init;
                        if (init !== undefined && typeof init.body === "string") {
                            try {
                                const parsedBody: unknown = JSON.parse(init.body);
                                if (isRecord(parsedBody)) {
                                    delete parsedBody.stream;
                                    strippedInit = { ...init, body: JSON.stringify(parsedBody) };
                                }
                            } catch {
                                // Leave body as-is.
                            }
                        }
                        const response = await fetchFn(endpointUrl, strippedInit);
                        responseHeadersRecord = headersToRecord(response.headers);
                        if (!response.ok) {
                            const text = await response.text().catch(() => "");
                            const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                            const apiError = new APICallError({
                                message,
                                url: endpointUrl,
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
                        const text = await response.text();
                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(text);
                        } catch (cause) {
                            const apiError = new APICallError({
                                message: "Failed to process successful response",
                                url: endpointUrl,
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
                        if (!isRecord(parsed) || !Array.isArray(parsed.content)) {
                            const apiError = new APICallError({
                                message: "Failed to process successful response",
                                url: endpointUrl,
                                requestBodyValues: capturedRequestBody,
                                statusCode: response.status,
                                responseHeaders: responseHeadersRecord,
                                responseBody: text,
                                cause: new TypeValidationError({
                                    value: parsed,
                                    cause: new Error("Invalid Anthropic message response"),
                                }),
                                isRetryable: isResponseRetryable(response.status, response.headers),
                            });
                            failHeaders(apiError);
                            throw apiError;
                        }
                        rawResponseBody = parsed;
                        settleHeaders();
                        const rawUsage = isRecord(parsed.usage) ? parsed.usage : {};
                        const sseEvents: Array<Record<string, unknown>> = [
                            {
                                type: "message_start",
                                message: {
                                    ...parsed,
                                    content: [],
                                    usage: { ...rawUsage, output_tokens: 0 },
                                },
                            },
                        ];
                        for (const [idx, block] of parsed.content.entries()) {
                            if (!isRecord(block)) continue;
                            if (block.type === "text" && typeof block.text === "string") {
                                sseEvents.push({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
                                sseEvents.push({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text } });
                                sseEvents.push({ type: "content_block_stop", index: idx });
                            } else if (block.type === "thinking" && typeof block.thinking === "string") {
                                sseEvents.push({ type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "" } });
                                sseEvents.push({ type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: block.thinking } });
                                sseEvents.push({ type: "content_block_stop", index: idx });
                            } else if (block.type === "tool_use") {
                                sseEvents.push({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id ?? "call", name: block.name ?? "tool", input: {} } });
                                sseEvents.push({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
                                sseEvents.push({ type: "content_block_stop", index: idx });
                            }
                        }
                        sseEvents.push({
                            type: "message_delta",
                            delta: {
                                stop_reason: typeof parsed.stop_reason === "string" ? parsed.stop_reason : "end_turn",
                                stop_sequence: parsed.stop_sequence ?? null,
                            },
                            usage: { output_tokens: typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0 },
                        });
                        sseEvents.push({ type: "message_stop" });
                        const sseBody = sseEvents.map((ev) => `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`).join("");
                        return new Response(sseBody, {
                            status: 200,
                            headers: { "content-type": "text/event-stream" },
                        });
                    } catch (error) {
                        failHeaders(error);
                        throw error;
                    }
                };

                let payloadError: unknown;
                const piStream = streamAnthropic(buildPiModel(callOptions.headers), dummyContext, {
                    apiKey: settings.apiKey ?? "plurnk-no-key",
                    signal: callOptions.abortSignal,
                    fetch: customFetch,
                    onPayload: (params) => {
                        if (!isRecord(params)) return;
                        try {
                            applyAnthropicPayload(params, callOptions, false);
                            capturedRequestBody = { ...params };
                            params.stream = true;
                        } catch (err) {
                            payloadError = err;
                            throw err;
                        }
                    },
                });
                const resultPromise = piStream.result();
                await Promise.race([
                    headersReady,
                    resultPromise.then(() => {
                        if (payloadError !== undefined) throw payloadError;
                    }),
                ]);
                if (payloadError !== undefined) throw payloadError;
                const assistantMsg = await resultPromise;
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
                const rawStop = typeof rawResponseBody?.stop_reason === "string"
                    ? rawResponseBody.stop_reason
                    : assistantMsg.rawStopReason;
                const u = assistantMsg.usage;
                const inputTotal = u.input + u.cacheRead + u.cacheWrite;
                return {
                    content,
                    finishReason: {
                        unified: toUnifiedFinishReason(rawStop),
                        raw: rawStop,
                    },
                    usage: {
                        inputTokens: {
                            total: inputTotal,
                            noCache: u.input,
                            cacheRead: u.cacheRead,
                            cacheWrite: u.cacheWrite,
                        },
                        outputTokens: {
                            total: u.output,
                            text: undefined,
                            reasoning: undefined,
                        },
                    },
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
                const fetchFn = settings.fetch ?? outboundFetch;
                let capturedRequestBody: unknown = {};
                let responseHeadersRecord: Record<string, string> | undefined;
                let settleHeaders!: () => void;
                let failHeaders!: (err: unknown) => void;
                const headersReady = new Promise<void>((resolve, reject) => {
                    settleHeaders = resolve;
                    failHeaders = reject;
                });
                const sseErrorChunks: Array<Record<string, unknown> & { error: unknown }> = [];
                let rawStreamReadError: unknown;

                const inspectAnthropicSse = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
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
                    const processBlock = (block: string, controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
                        const lines = block.split(/\r?\n/);
                        const dataLines: string[] = [];
                        for (const line of lines) {
                            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
                        }
                        if (dataLines.length > 0) {
                            try {
                                const parsed: unknown = JSON.parse(dataLines.join("\n").trim());
                                if (isRecord(parsed) && parsed.type === "error" && isRecord(parsed.error)) {
                                    sseErrorChunks.push({ ...parsed, error: parsed.error });
                                    closeStream(controller);
                                    return true;
                                }
                            } catch {
                                // Forward unparsed block as-is.
                            }
                        }
                        if (block.length > 0) enqueueBytes(controller, encoder.encode(`${block}\n\n`));
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
                                        if (processBlock(block, controller)) return;
                                        return;
                                    }
                                    const { done, value } = await reader.read();
                                    if (done) {
                                        buffer += decoder.decode();
                                        if (buffer.trim().length > 0) {
                                            if (processBlock(buffer, controller)) return;
                                            buffer = "";
                                        }
                                        closeStream(controller);
                                        return;
                                    }
                                    buffer += decoder.decode(value, { stream: true });
                                }
                            } catch (err) {
                                rawStreamReadError = err;
                                closeStream(controller);
                            }
                        },
                        async cancel(reason) {
                            closed = true;
                            await reader.cancel(reason).catch(() => {});
                        },
                    });
                };

                const customFetch: typeof globalThis.fetch = async (_input, init) => {
                    try {
                        const response = await fetchFn(endpointUrl, init);
                        responseHeadersRecord = headersToRecord(response.headers);
                        if (!response.ok) {
                            const text = await response.text().catch(() => "");
                            const { message, data } = extractErrorMessage(text, response.statusText, response.status);
                            const apiError = new APICallError({
                                message,
                                url: endpointUrl,
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
                        return new Response(response.body === null ? null : inspectAnthropicSse(response.body), {
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
                    if (!streamClosed) streamController.enqueue(part);
                };
                const safeClose = (): void => {
                    if (!streamClosed) {
                        streamClosed = true;
                        streamController.close();
                    }
                };
                const stream = new ReadableStream<LanguageModelStreamPart>({
                    start(controller) {
                        streamController = controller;
                        controller.enqueue({ type: "stream-start", warnings: [] });
                    },
                });

                let payloadError: unknown;
                const piStream = streamAnthropic(buildPiModel(callOptions.headers), dummyContext, {
                    apiKey: settings.apiKey ?? "plurnk-no-key",
                    signal: callOptions.abortSignal,
                    fetch: customFetch,
                    onPayload: (params) => {
                        if (!isRecord(params)) return;
                        try {
                            applyAnthropicPayload(params, callOptions, true);
                            capturedRequestBody = { ...params };
                        } catch (err) {
                            payloadError = err;
                            throw err;
                        }
                    },
                    onProviderStreamEvent: (event) => {
                        safeEnqueue({ type: "raw", rawValue: event });
                        if (isRecord(event) && event.type === "message_start" && isRecord(event.message)) {
                            const id = typeof event.message.id === "string" ? event.message.id : undefined;
                            const mId = typeof event.message.model === "string" ? event.message.model : undefined;
                            if (id !== undefined || mId !== undefined) {
                                safeEnqueue({
                                    type: "response-metadata",
                                    ...(id === undefined ? {} : { id }),
                                    ...(mId === undefined ? {} : { modelId: mId }),
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
                        if (sseErrorChunks.length > 0) {
                            for (const errChunk of sseErrorChunks) {
                                safeEnqueue({ type: "raw", rawValue: errChunk });
                                safeEnqueue({ type: "error", error: errChunk.error });
                            }
                            safeClose();
                            originalPush(event);
                            return;
                        }
                        if (rawStreamReadError !== undefined) {
                            safeEnqueue({ type: "error", error: rawStreamReadError });
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
                            const u = event.message.usage;
                            const rawStop = event.message.rawStopReason;
                            safeEnqueue({
                                type: "finish",
                                finishReason: {
                                    unified: toUnifiedFinishReason(rawStop),
                                    raw: rawStop,
                                },
                                usage: {
                                    inputTokens: {
                                        total: u.input + u.cacheRead + u.cacheWrite,
                                        noCache: u.input,
                                        cacheRead: u.cacheRead,
                                        cacheWrite: u.cacheWrite,
                                    },
                                    outputTokens: {
                                        total: u.output,
                                        text: undefined,
                                        reasoning: undefined,
                                    },
                                },
                            });
                            safeClose();
                        } else {
                            const rawStop = event.error.rawStopReason;
                            const msg = event.error.errorMessage ?? "";
                            if (rawStop !== undefined && msg === `Provider stop_reason: ${rawStop}`) {
                                const u = event.error.usage;
                                safeEnqueue({
                                    type: "finish",
                                    finishReason: {
                                        unified: toUnifiedFinishReason(rawStop),
                                        raw: rawStop,
                                    },
                                    usage: {
                                        inputTokens: {
                                            total: u.input + u.cacheRead + u.cacheWrite,
                                            noCache: u.input,
                                            cacheRead: u.cacheRead,
                                            cacheWrite: u.cacheWrite,
                                        },
                                        outputTokens: {
                                            total: u.output,
                                            text: undefined,
                                            reasoning: undefined,
                                        },
                                    },
                                });
                            } else {
                                safeEnqueue({ type: "error", error: new Error(msg || "Anthropic stream error") });
                            }
                            safeClose();
                        }
                    }
                    originalPush(event);
                };

                const resultPromise = piStream.result();
                await Promise.race([
                    headersReady,
                    resultPromise.then(() => {
                        if (payloadError !== undefined) throw payloadError;
                    }),
                ]);
                if (payloadError !== undefined) throw payloadError;
                return {
                    stream,
                    response: { ...(responseHeadersRecord === undefined ? {} : { headers: responseHeadersRecord }) },
                };
            },
        };
    };

    return Object.assign(
        (modelId: string) => makeLanguageModel(modelId),
        { languageModel: makeLanguageModel, chat: makeLanguageModel },
    );
};

const parseGoogleUsage = (usageMetadata: unknown): LanguageModelV4Usage => {
    const meta = isRecord(usageMetadata) ? usageMetadata : undefined;
    const promptTokens = typeof meta?.promptTokenCount === "number" ? meta.promptTokenCount : undefined;
    const candidateTokens = typeof meta?.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0;
    const thoughtsTokens = typeof meta?.thoughtsTokenCount === "number" ? meta.thoughtsTokenCount : undefined;
    const cachedTokens = typeof meta?.cachedContentTokenCount === "number" ? meta.cachedContentTokenCount : undefined;
    const outputTotal = typeof meta?.candidatesTokenCount === "number" || thoughtsTokens !== undefined
        ? candidateTokens + (thoughtsTokens ?? 0)
        : undefined;
    return {
        inputTokens: {
            total: promptTokens,
            noCache: promptTokens !== undefined && cachedTokens !== undefined ? promptTokens - cachedTokens : promptTokens,
            cacheRead: cachedTokens,
            cacheWrite: undefined,
        },
        outputTokens: {
            total: outputTotal,
            text: outputTotal !== undefined && thoughtsTokens !== undefined ? candidateTokens : outputTotal,
            reasoning: thoughtsTokens,
        },
    };
};

export const createGoogleGenerativeAI = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider => {
    const resolvedBaseUrl = (settings.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");

    const makeLanguageModel = (modelId: string): LanguageModel => {
        const modelPath = modelId.startsWith("models/") ? modelId : `models/${modelId}`;

        const buildGoogleRequestBody = (callOptions: LanguageModelCallOptions): Record<string, unknown> => {
            const systemMessages = callOptions.prompt.filter(
                (m): m is Extract<LanguageModelPromptMessage, { role: "system" }> => m.role === "system",
            );
            const convMessages = callOptions.prompt.filter(
                (m): m is Exclude<LanguageModelPromptMessage, { role: "system" }> => m.role !== "system",
            );
            const contents = convMessages.map((m) => {
                if (m.role === "assistant") {
                    return {
                        role: "model",
                        parts: m.content
                            .filter((p): p is Extract<typeof m.content[number], { type: "text" }> => p.type === "text")
                            .map((p) => ({ text: p.text })),
                    };
                }
                return {
                    role: "user",
                    parts: m.content.map((p) => {
                        if (p.type === "text") return { text: p.text };
                        const rawBytes = p.data instanceof Uint8Array
                            ? p.data
                            : isRecord(p.data) && p.data.data instanceof Uint8Array
                                ? p.data.data
                                : undefined;
                        const base64 = rawBytes !== undefined
                            ? encodeBytesBase64(rawBytes)
                            : typeof p.data === "string"
                                ? p.data
                                : isRecord(p.data) && typeof p.data.data === "string"
                                    ? p.data.data
                                    : "";
                        return {
                            inlineData: {
                                mimeType: p.mediaType,
                                data: base64,
                            },
                        };
                    }),
                };
            });

            const googleOpts = isRecord(callOptions.providerOptions?.google)
                ? callOptions.providerOptions.google
                : undefined;
            const rawThinkingConfig = isRecord(googleOpts?.thinkingConfig)
                ? { ...googleOpts.thinkingConfig }
                : {};
            if (callOptions.reasoning !== undefined
                && callOptions.reasoning !== "none"
                && callOptions.reasoning !== "provider-default") {
                rawThinkingConfig.thinkingLevel = callOptions.reasoning;
            }
            const generationConfig: Record<string, unknown> = {
                ...(callOptions.maxOutputTokens === undefined ? {} : { maxOutputTokens: callOptions.maxOutputTokens }),
                ...(callOptions.temperature === undefined ? {} : { temperature: callOptions.temperature }),
                ...(callOptions.topP === undefined ? {} : { topP: callOptions.topP }),
                ...(callOptions.topK === undefined ? {} : { topK: callOptions.topK }),
                ...(callOptions.presencePenalty === undefined ? {} : { presencePenalty: callOptions.presencePenalty }),
                ...(callOptions.frequencyPenalty === undefined ? {} : { frequencyPenalty: callOptions.frequencyPenalty }),
                ...(callOptions.seed === undefined ? {} : { seed: callOptions.seed }),
                ...(callOptions.stopSequences === undefined ? {} : { stopSequences: callOptions.stopSequences }),
                ...(Object.keys(rawThinkingConfig).length === 0 ? {} : { thinkingConfig: rawThinkingConfig }),
            };
            const body: Record<string, unknown> = {
                ...(systemMessages.length === 0
                    ? {}
                    : { systemInstruction: { parts: systemMessages.map((m) => ({ text: m.content })) } }),
                contents,
                ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
            };
            if (googleOpts !== undefined) {
                for (const [key, value] of Object.entries(googleOpts)) {
                    if (key === "thinkingConfig" || value === undefined) continue;
                    body[key] = value;
                }
            }
            return withoutNativeTools(body, "generate-content");
        };

        const buildHeaders = (callHeaders?: Record<string, string | undefined>): Record<string, string> => {
            const headers: Record<string, string> = {
                "content-type": "application/json",
                ...(settings.apiKey === undefined ? {} : { "x-goog-api-key": settings.apiKey }),
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
            specificationVersion: "v4",
            provider: "google.generative-ai",
            modelId,
            supportedUrls: {},
            async doGenerate(callOptions: LanguageModelCallOptions): Promise<LanguageModelGenerateResult> {
                callOptions.abortSignal?.throwIfAborted();
                const fetchFn = settings.fetch ?? outboundFetch;
                const url = `${resolvedBaseUrl}/${modelPath}:generateContent`;
                const requestBody = buildGoogleRequestBody(callOptions);
                const response = await fetchFn(url, {
                    method: "POST",
                    headers: buildHeaders(callOptions.headers),
                    body: JSON.stringify(requestBody),
                    signal: callOptions.abortSignal,
                });
                const responseHeaders = headersToRecord(response.headers);
                const text = await response.text();
                if (!response.ok) {
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
                            cause: new Error("Invalid Google generateContent response"),
                        }),
                        isRetryable: isResponseRetryable(response.status, response.headers),
                    });
                }
                const candidate = isRecord(parsed.candidates[0]) ? parsed.candidates[0] : undefined;
                const contentObj = isRecord(candidate?.content) ? candidate.content : undefined;
                const rawParts = Array.isArray(contentObj?.parts) ? contentObj.parts : [];
                const content: LanguageModelContentPart[] = [];
                for (const part of rawParts) {
                    if (!isRecord(part)) continue;
                    if (part.thought === true && typeof part.text === "string") {
                        content.push({ type: "reasoning", text: part.text });
                    } else if (typeof part.text === "string") {
                        content.push({ type: "text", text: part.text });
                    } else if (isRecord(part.functionCall)) {
                        content.push({
                            type: "tool-call",
                            toolCallId: typeof part.functionCall.id === "string" ? part.functionCall.id : "call",
                            toolName: typeof part.functionCall.name === "string" ? part.functionCall.name : "tool",
                            input: JSON.stringify(part.functionCall.args ?? {}),
                        });
                    }
                }
                const rawFinish = typeof candidate?.finishReason === "string" ? candidate.finishReason : undefined;
                return {
                    content,
                    finishReason: {
                        unified: toUnifiedFinishReason(rawFinish),
                        raw: rawFinish,
                    },
                    usage: parseGoogleUsage(parsed.usageMetadata),
                    response: {
                        id: typeof parsed.responseId === "string" ? parsed.responseId : undefined,
                        modelId: typeof parsed.modelVersion === "string" ? parsed.modelVersion : modelId,
                        headers: responseHeaders,
                        body: parsed,
                    },
                    warnings: [],
                };
            },
            async doStream(callOptions: LanguageModelCallOptions): Promise<LanguageModelStreamResult> {
                callOptions.abortSignal?.throwIfAborted();
                const fetchFn = settings.fetch ?? outboundFetch;
                const url = `${resolvedBaseUrl}/${modelPath}:streamGenerateContent?alt=sse`;
                const requestBody = buildGoogleRequestBody(callOptions);
                const response = await fetchFn(url, {
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

                const reader = response.body?.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let lastUsage: LanguageModelV4Usage = {
                    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
                };
                let lastRawFinish: string | undefined;
                let started = false;

                const parseChunkAndEnqueue = (
                    block: string,
                    controller: ReadableStreamDefaultController<LanguageModelStreamPart>,
                ): void => {
                    const lines = block.split(/\r?\n/);
                    const dataLines: string[] = [];
                    for (const line of lines) {
                        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
                    }
                    if (dataLines.length === 0) return;
                    const data = dataLines.join("\n").trim();
                    if (data === "[DONE]" || data.length === 0) return;
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(data);
                    } catch {
                        return;
                    }
                    if (!isRecord(parsed)) return;
                    controller.enqueue({ type: "raw", rawValue: parsed });
                    if (typeof parsed.responseId === "string" || typeof parsed.modelVersion === "string") {
                        controller.enqueue({
                            type: "response-metadata",
                            ...(typeof parsed.responseId === "string" ? { id: parsed.responseId } : {}),
                            ...(typeof parsed.modelVersion === "string" ? { modelId: parsed.modelVersion } : {}),
                        });
                    }
                    if (isRecord(parsed.usageMetadata)) {
                        lastUsage = parseGoogleUsage(parsed.usageMetadata);
                    }
                    if (Array.isArray(parsed.candidates) && isRecord(parsed.candidates[0])) {
                        const cand = parsed.candidates[0];
                        if (typeof cand.finishReason === "string") lastRawFinish = cand.finishReason;
                        const contentObj = isRecord(cand.content) ? cand.content : undefined;
                        if (Array.isArray(contentObj?.parts)) {
                            for (const part of contentObj.parts) {
                                if (!isRecord(part)) continue;
                                if (part.thought === true && typeof part.text === "string" && part.text.length > 0) {
                                    controller.enqueue({ type: "reasoning-delta", id: "reasoning-0", delta: part.text });
                                } else if (typeof part.text === "string" && part.text.length > 0) {
                                    controller.enqueue({ type: "text-delta", id: "text-0", delta: part.text });
                                }
                            }
                        }
                    }
                };

                const stream = new ReadableStream<LanguageModelStreamPart>({
                    async pull(controller) {
                        if (!started) {
                            started = true;
                            controller.enqueue({ type: "stream-start", warnings: [] });
                        }
                        if (reader === undefined) {
                            controller.enqueue({
                                type: "finish",
                                finishReason: { unified: toUnifiedFinishReason(lastRawFinish), raw: lastRawFinish },
                                usage: lastUsage,
                            });
                            controller.close();
                            return;
                        }
                        try {
                            while (true) {
                                const boundary = buffer.match(/\r?\n\r?\n/);
                                if (boundary?.index !== undefined) {
                                    const block = buffer.slice(0, boundary.index);
                                    buffer = buffer.slice(boundary.index + boundary[0].length);
                                    parseChunkAndEnqueue(block, controller);
                                    return;
                                }
                                const { done, value } = await reader.read();
                                if (done) {
                                    buffer += decoder.decode();
                                    if (buffer.trim().length > 0) {
                                        parseChunkAndEnqueue(buffer, controller);
                                        buffer = "";
                                    }
                                    controller.enqueue({
                                        type: "finish",
                                        finishReason: { unified: toUnifiedFinishReason(lastRawFinish), raw: lastRawFinish },
                                        usage: lastUsage,
                                    });
                                    controller.close();
                                    return;
                                }
                                buffer += decoder.decode(value, { stream: true });
                            }
                        } catch (error) {
                            controller.enqueue({ type: "error", error });
                            controller.close();
                        }
                    },
                    async cancel(reason) {
                        await reader?.cancel(reason).catch(() => {});
                    },
                });

                return {
                    stream,
                    response: { headers: responseHeaders },
                };
            },
        };
    };

    return Object.assign(
        (modelId: string) => makeLanguageModel(modelId),
        { languageModel: makeLanguageModel, chat: makeLanguageModel },
    );
};

export const createGoogle = createGoogleGenerativeAI;

export const createAmazonBedrock = (settings: SdkProviderSettings = {}): OpenAICompatibleProvider => {
    const region = settings.region ?? "us-east-1";
    const resolvedBaseUrl = (settings.baseURL ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(/\/+$/, "");

    const makeLanguageModel = (modelId: string): LanguageModel => {
        const buildBedrockBody = (callOptions: LanguageModelCallOptions): Record<string, unknown> => {
            const systemMessages = callOptions.prompt.filter(
                (m): m is Extract<LanguageModelPromptMessage, { role: "system" }> => m.role === "system",
            );
            const convMessages = callOptions.prompt.filter(
                (m): m is Exclude<LanguageModelPromptMessage, { role: "system" }> => m.role !== "system",
            );
            const messages = convMessages.map((m) => ({
                role: m.role,
                content: m.content.map((p) => {
                    if (p.type === "text") return { text: p.text };
                    const rawBytes = p.data instanceof Uint8Array
                        ? p.data
                        : isRecord(p.data) && p.data.data instanceof Uint8Array
                            ? p.data.data
                            : undefined;
                    const base64 = rawBytes !== undefined
                        ? encodeBytesBase64(rawBytes)
                        : typeof p.data === "string"
                            ? p.data
                            : isRecord(p.data) && typeof p.data.data === "string"
                                ? p.data.data
                                : "";
                    const format = p.mediaType.split("/")[1] ?? "png";
                    return {
                        image: {
                            format,
                            source: { bytes: base64 },
                        },
                    };
                }),
            }));
            const inferenceConfig: Record<string, unknown> = {
                ...(callOptions.maxOutputTokens === undefined ? {} : { maxTokens: callOptions.maxOutputTokens }),
                ...(callOptions.temperature === undefined ? {} : { temperature: callOptions.temperature }),
                ...(callOptions.topP === undefined ? {} : { topP: callOptions.topP }),
                ...(callOptions.stopSequences === undefined ? {} : { stopSequences: callOptions.stopSequences }),
            };
            const bedrockOpts = isRecord(callOptions.providerOptions?.bedrock)
                ? callOptions.providerOptions.bedrock
                : undefined;
            const additionalFields: Record<string, unknown> = {
                ...(callOptions.topK === undefined ? {} : { top_k: callOptions.topK }),
                ...(isRecord(bedrockOpts?.additionalModelRequestFields) ? bedrockOpts.additionalModelRequestFields : {}),
            };
            if (isRecord(bedrockOpts?.reasoningConfig)) {
                additionalFields.thinking = bedrockOpts.reasoningConfig;
            }
            const body: Record<string, unknown> = {
                ...(systemMessages.length === 0 ? {} : { system: systemMessages.map((m) => ({ text: m.content })) }),
                messages,
                ...(Object.keys(inferenceConfig).length === 0 ? {} : { inferenceConfig }),
                ...(Object.keys(additionalFields).length === 0 ? {} : { additionalModelRequestFields: additionalFields }),
                ...(bedrockOpts?.serviceTier === undefined ? {} : { serviceTier: bedrockOpts.serviceTier }),
            };
            return body;
        };

        const buildHeaders = (callHeaders?: Record<string, string | undefined>): Record<string, string> => {
            const headers: Record<string, string> = {
                "content-type": "application/json",
                ...(settings.apiKey === undefined ? {} : { Authorization: `Bearer ${settings.apiKey}` }),
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
            specificationVersion: "v4",
            provider: "amazon-bedrock.converse",
            modelId,
            supportedUrls: {},
            async doGenerate(callOptions: LanguageModelCallOptions): Promise<LanguageModelGenerateResult> {
                callOptions.abortSignal?.throwIfAborted();
                const fetchFn = settings.fetch ?? outboundFetch;
                const url = `${resolvedBaseUrl}/model/${encodeURIComponent(modelId)}/converse`;
                const requestBody = buildBedrockBody(callOptions);
                const response = await fetchFn(url, {
                    method: "POST",
                    headers: buildHeaders(callOptions.headers),
                    body: JSON.stringify(requestBody),
                    signal: callOptions.abortSignal,
                });
                const responseHeaders = headersToRecord(response.headers);
                const text = await response.text();
                if (!response.ok) {
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
                const parsed: unknown = JSON.parse(text);
                if (!isRecord(parsed)) {
                    throw new APICallError({
                        message: "Failed to process successful response",
                        url,
                        requestBodyValues: requestBody,
                        statusCode: response.status,
                        responseHeaders,
                        responseBody: text,
                        isRetryable: false,
                    });
                }
                const outputObj = isRecord(parsed.output) ? parsed.output : undefined;
                const msgObj = isRecord(outputObj?.message) ? outputObj.message : undefined;
                const rawContent = Array.isArray(msgObj?.content) ? msgObj.content : [];
                const content: LanguageModelContentPart[] = [];
                for (const item of rawContent) {
                    if (!isRecord(item)) continue;
                    if (typeof item.text === "string") {
                        content.push({ type: "text", text: item.text });
                    } else if (isRecord(item.reasoningContent) && isRecord(item.reasoningContent.reasoningText) && typeof item.reasoningContent.reasoningText.text === "string") {
                        content.push({ type: "reasoning", text: item.reasoningContent.reasoningText.text });
                    }
                }
                const rawStop = typeof parsed.stopReason === "string" ? parsed.stopReason : undefined;
                const usageObj = isRecord(parsed.usage) ? parsed.usage : undefined;
                const inputTokens = typeof usageObj?.inputTokens === "number" ? usageObj.inputTokens : undefined;
                const outputTokens = typeof usageObj?.outputTokens === "number" ? usageObj.outputTokens : undefined;
                const cacheRead = typeof usageObj?.cacheReadInputTokens === "number" ? usageObj.cacheReadInputTokens : undefined;
                const cacheWrite = typeof usageObj?.cacheWriteInputTokens === "number" ? usageObj.cacheWriteInputTokens : undefined;
                const totalInput = inputTokens !== undefined
                    ? inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0)
                    : undefined;
                return {
                    content,
                    finishReason: {
                        unified: toUnifiedFinishReason(rawStop),
                        raw: rawStop,
                    },
                    usage: {
                        inputTokens: {
                            total: totalInput,
                            noCache: inputTokens,
                            cacheRead,
                            cacheWrite,
                        },
                        outputTokens: {
                            total: outputTokens,
                            text: outputTokens,
                            reasoning: undefined,
                        },
                    },
                    response: {
                        modelId,
                        headers: responseHeaders,
                        body: parsed,
                    },
                    warnings: [],
                };
            },
            async doStream(callOptions: LanguageModelCallOptions): Promise<LanguageModelStreamResult> {
                const generated = await this.doGenerate(callOptions);
                const stream = new ReadableStream<LanguageModelStreamPart>({
                    start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        if (generated.response?.body !== undefined) {
                            controller.enqueue({ type: "raw", rawValue: generated.response.body });
                        }
                        for (const part of generated.content) {
                            if (part.type === "reasoning") {
                                controller.enqueue({ type: "reasoning-delta", id: "reasoning-0", delta: part.text });
                            } else if (part.type === "text") {
                                controller.enqueue({ type: "text-delta", id: "text-0", delta: part.text });
                            }
                        }
                        controller.enqueue({
                            type: "finish",
                            finishReason: generated.finishReason,
                            usage: generated.usage,
                        });
                        controller.close();
                    },
                });
                return {
                    stream,
                    response: { ...(generated.response?.headers === undefined ? {} : { headers: generated.response.headers }) },
                };
            },
        };
    };

    return Object.assign(
        (modelId: string) => makeLanguageModel(modelId),
        { languageModel: makeLanguageModel, chat: makeLanguageModel },
    );
};

export type SdkModel = {
    readonly endpoint?: string;
    readonly languageModel?: LanguageModelSource;
    readonly normalizeCost?: ProviderCostNormalizer;
    readonly compatible?: {
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
    };
    readonly cacheAffinity?: CacheAffinity;
    readonly systemCacheProviderOptions?: AiSdkProviderOptions;
    readonly reasoningResponseProviderOptions?: AiSdkProviderOptions;
    readonly additiveReasoningProvider?: "anthropic" | "bedrock";
    // {§provider-request-controls} — the global controls this SDK documents as provider options.
    readonly requestControls?: NativeRequestControls;
    readonly catalog: ProviderInfo | null;
};

// The release generator admits only packages implemented by this package.
// Derive runtime readiness from that same pinned provider projection instead
// of maintaining a second support list beside the construction switch.
const supportedSdkPackages = new Set(
    Object.values(providerCatalogSnapshot()).map(({ npm }) => npm),
);

// {§openrouter-app-attribution}: an OpenRouter-SDK route's application attribution is its provider's declaration,
// handed to the SDK, which owns the headers.
const openRouterAttribution = (provider: string, env: NodeJS.ProcessEnv): { appUrl?: string; appName?: string } => {
    const [urlKey, rawUrl] = providerSetting(provider, env, "APP_URL");
    const url = rawUrl?.trim();
    if (url === undefined || url === "") return {};
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch (cause) {
        throw new Error(`${provider} provider: ${urlKey} must be an absolute HTTP(S) URL.`, { cause });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${provider} provider: ${urlKey} must be an absolute HTTP(S) URL.`);
    }
    const name = providerSetting(provider, env, "APP_NAME")[1]?.trim();
    return { appUrl: parsed.href, ...(name === undefined || name === "" ? {} : { appName: name }) };
};

// {§provider-fact-authority} — one credential declaration holds exactly one
// name. An ordered fallback list would paper over an operator/catalog naming
// mismatch; that mismatch belongs at its owning boundary instead.
const singleCredentialName = (provider: string, value: string): string => {
    const name = value.trim();
    if (name.length === 0) throw new Error(`${provider} provider: API_KEY_ENV must name one environment variable.`);
    if (name.includes(",")) {
        throw new Error(
            `${provider} provider: API_KEY_ENV holds one exact name, never an ordered fallback; reconcile the operator environment with the Models.dev contract instead.`,
        );
    }
    return name;
};

export const configuredProviderInfo = (
    provider: string,
    env: NodeJS.ProcessEnv,
): ProviderInfo | null => {
    const prefix = `PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}`;
    const npm = env[`${prefix}_NPM`];
    if (npm === undefined || npm.length === 0) return null;
    const declared = env[`${prefix}_API_KEY_ENV`];
    const keyNames = declared === undefined
        ? []
        : [singleCredentialName(provider, declared)];
    const api = env[`${prefix}_BASE_URL`];
    return {
        id: provider,
        name: provider,
        npm,
        env: keyNames,
        ...(api === undefined || api.length === 0 ? {} : { api }),
    };
};

const firstSet = (env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined => {
    for (const name of names) {
        const value = env[name];
        if (value !== undefined && value.length > 0) return value;
    }
    return undefined;
};

const isSet = (env: NodeJS.ProcessEnv, name: string): boolean => {
    const value = env[name];
    return value !== undefined && value.length > 0;
};

const configuredKeyNames = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): readonly string[] => {
    const configured = env[`PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}_API_KEY_ENV`];
    return configured === undefined || configured.length === 0
        ? catalog.env
        : [singleCredentialName(provider, configured)];
};

const credentialCandidates = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): readonly string[] => {
    const names = configuredKeyNames(provider, env, catalog);
    const credentials = names.filter(isProviderCredentialName);
    return credentials.length > 0 ? credentials : names;
};

const configuredBaseUrl = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
    override?: string,
): string | undefined => {
    const prefix = envPrefix(provider);
    return override
        ?? env[`PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL`]
        ?? env[`${prefix}_BASE_URL`]
        ?? catalog.api;
};

const templateEnvironmentNames = (value: string | undefined): readonly string[] => value === undefined
    ? []
    : [...new Set([...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]))];

// A list the readiness contract requires to name at least one item: built, never claimed.
const nonEmpty = <T>(items: readonly T[], subject: string): [T, ...T[]] => {
    if (items.length === 0) throw new TypeError(`A model readiness cause names no ${subject}.`);
    const [first, ...rest] = items;
    return [first, ...rest];
};

const missingCause = (
    kind: ModelReadinessCause["kind"],
    alternatives: readonly (readonly string[])[],
): ModelReadinessCause => ({
    kind,
    alternatives: nonEmpty(alternatives.map((alternative) => nonEmpty(alternative, "variable in an alternative")), "alternative"),
});

const bedrockReadinessCauses = (
    env: NodeJS.ProcessEnv,
    hasExplicitBaseUrl: boolean,
): ModelReadinessCause[] => {
    const bearer = isSet(env, "AWS_BEARER_TOKEN_BEDROCK");
    const sigv4 = isSet(env, "AWS_ACCESS_KEY_ID") && isSet(env, "AWS_SECRET_ACCESS_KEY");
    const region = isSet(env, "AWS_REGION") || isSet(env, "AWS_DEFAULT_REGION");
    if (bearer) {
        return hasExplicitBaseUrl || region
            ? []
            : [missingCause("configuration", [["AWS_REGION"], ["AWS_DEFAULT_REGION"]])];
    }
    if (sigv4) {
        return region
            ? []
            : [missingCause("configuration", [["AWS_REGION"], ["AWS_DEFAULT_REGION"]])];
    }
    return [missingCause("credential", hasExplicitBaseUrl
        ? [
            ["AWS_BEARER_TOKEN_BEDROCK"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
        ]
        : [
            ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"],
            ["AWS_BEARER_TOKEN_BEDROCK", "AWS_DEFAULT_REGION"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
        ])];
};

// Local evidence only: this shares the exact environment and endpoint rules
// used by createSdkModel, but never probes a provider or validates a secret.
export const providerReadiness = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): ModelReadiness | null => {
    const catalog = lookupProvider(provider) ?? configuredProviderInfo(provider, env);
    if (catalog === null) return null;
    if (!supportedSdkPackages.has(catalog.npm)) return null;
    const rawUrl = configuredBaseUrl(provider, env, catalog, baseUrlOverride);
    const missingCoordinates = templateEnvironmentNames(rawUrl).filter((name) => !isSet(env, name));
    const causes: ModelReadinessCause[] = missingCoordinates.length === 0
        ? []
        : [missingCause("configuration", [missingCoordinates])];

    if (catalog.npm === "@ai-sdk/amazon-bedrock") {
        causes.push(...bedrockReadinessCauses(env, rawUrl !== undefined));
    } else {
        const candidates = credentialCandidates(provider, env, catalog);
        const credentialRequired = catalog.npm !== "@ai-sdk/openai-compatible" || candidates.length > 0;
        if (credentialRequired && candidates.length === 0) {
            causes.push(missingCause("configuration", [[
                `PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}_API_KEY_ENV`,
            ]]));
        } else if (credentialRequired && firstSet(env, candidates) === undefined) {
            causes.push(missingCause("credential", candidates.map((name) => [name])));
        }
        if (catalog.npm === "@ai-sdk/openai-compatible" && rawUrl === undefined) {
            const prefix = envPrefix(provider);
            causes.push(missingCause("configuration", [
                [`PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL`],
                [`${prefix}_BASE_URL`],
            ]));
        }
    }
    return Validator.assertModelReadiness({ ready: causes.length === 0, causes });
};

const assertProviderReady = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): void => {
    const readiness = providerReadiness(provider, env, baseUrlOverride);
    if (readiness === null || readiness.ready) return;
    const requirements = readiness.causes
        .map(({ alternatives }) => alternatives.map((group) => group.join(" and ")).join(" or "))
        .join("; ");
    throw new Error(`${provider} provider: ${requirements} must be set`);
};

const expandEnv = (value: string, env: NodeJS.ProcessEnv, provider: string): string =>
    value.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
        const replacement = env[name];
        if (replacement === undefined || replacement.length === 0) {
            throw new Error(`${provider} provider: ${name} must be set to resolve the Models.dev API URL`);
        }
        return replacement;
    });

const baseUrl = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
    override?: string,
): string | undefined => {
    // {§provider-fact-authority} — distinct sources, one precedence: the PLURNK
    // knob, then the provider-native convention (OPENAI_BASE_URL etc.), then
    // the catalog. This is not an alias fallback: each source is a different
    // owner, and the catalog remains the last authority.
    const value = configuredBaseUrl(provider, env, catalog, override);
    return value === undefined ? undefined : expandEnv(value, env, provider).replace(/\/+$/, "");
};

const requireApiKey = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): string => {
    // {§provider-fact-authority} — a catalog `env` list mixes credentials with
    // non-secret coordinates; the credential is the credential-named one.
    const candidates = credentialCandidates(provider, env, catalog);
    const key = firstSet(env, candidates);
    if (key === undefined) throw new Error(`${provider} provider: ${candidates.join(" or ")} must be set`);
    return key;
};

const resolveSdkProvider = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): { catalog: ProviderInfo; url: string | undefined } | null => {
    const catalog = lookupProvider(provider) ?? configuredProviderInfo(provider, env);
    if (catalog === null) return null;
    if (!supportedSdkPackages.has(catalog.npm)) {
        throw new Error(`${provider} provider: Models.dev declares unsupported AI SDK package ${catalog.npm}`);
    }
    assertProviderReady(provider, env, baseUrlOverride);
    return { catalog, url: baseUrl(provider, env, catalog, baseUrlOverride) };
};

export const createSdkModel = (
    provider: string,
    model: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): SdkModel | null => {
    const resolved = resolveSdkProvider(provider, env, baseUrlOverride);
    if (resolved === null) return null;
    const { catalog, url } = resolved;
    const cacheAffinity = cacheAffinityDeclarationFromEnv(env, provider);
    const systemCacheProviderOptions = providerModelOptions(provider, env, "SYSTEM_CACHE_OPTIONS", model);
    return {
        ...modelFromSdk(provider, model, { ...env }, catalog, url),
        ...(systemCacheProviderOptions === undefined ? {} : { systemCacheProviderOptions }),
        cacheAffinity,
        endpoint: url,
    };
};

const modelFromSdk = (
    provider: string,
    model: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
    url: string | undefined,
): SdkModel => {
    const normalizeCost = providerCostNormalizer(catalog.npm);
    const attribution = catalog.npm === "@openrouter/ai-sdk-provider" ? openRouterAttribution(provider, env) : {};

    switch (catalog.npm) {
        case "@ai-sdk/openai":
            return {
                languageModel: (fetch) => createOpenAI({ apiKey: requireApiKey(provider, env, catalog), baseURL: url, fetch: withoutNativeToolsFetch("openai", fetch) }).chat(model),
                requestControls: { namespace: "openai", serviceTier: true, logprobs: true },
                catalog,
            };
        case "@ai-sdk/groq":
            return {
                languageModel: (fetch) => createGroq({ apiKey: requireApiKey(provider, env, catalog), baseURL: url, fetch: withoutNativeToolsFetch("openai", fetch) }).languageModel(model),
                requestControls: { namespace: "groq", serviceTier: true, logprobs: false },
                catalog,
            };
        case "@ai-sdk/cerebras":
            return {
                languageModel: (fetch) => createCerebras({ apiKey: requireApiKey(provider, env, catalog), baseURL: url, fetch: withoutNativeToolsFetch("openai", fetch) }).languageModel(model),
                requestControls: { namespace: "cerebras", serviceTier: true, logprobs: false },
                catalog,
            };
        case "@ai-sdk/mistral":
            return {
                languageModel: (fetch) => createMistral({ apiKey: requireApiKey(provider, env, catalog), baseURL: url, fetch: withoutNativeToolsFetch("openai", fetch) }).languageModel(model),
                requestControls: { namespace: "mistral", serviceTier: false, logprobs: false },
                catalog,
            };
        case "@ai-sdk/togetherai":
            return {
                languageModel: (fetch) => createTogetherAI({ apiKey: requireApiKey(provider, env, catalog), baseURL: url, fetch: withoutNativeToolsFetch("openai", fetch) }).languageModel(model),
                requestControls: { namespace: "togetherai", serviceTier: false, logprobs: false },
                catalog,
            };
        case "@ai-sdk/xai":
            return {
                languageModel: (fetch) => createXai({ apiKey: requireApiKey(provider, env, catalog), baseURL: url, fetch: withoutNativeToolsFetch("openai", fetch) }).languageModel(model),
                requestControls: { namespace: "xai", serviceTier: true, logprobs: false },
                catalog,
            };
        case "@ai-sdk/deepinfra":
            return {
                languageModel: (fetch) => createDeepInfra({ apiKey: requireApiKey(provider, env, catalog), baseURL: url, fetch: withoutNativeToolsFetch("openai", fetch) }).languageModel(model),
                ...(normalizeCost === undefined ? {} : { normalizeCost }),
                requestControls: { namespace: "deepinfra", serviceTier: false, logprobs: false },
                catalog,
            };
        case "@ai-sdk/google":
            return {
                languageModel: (fetch) => createGoogle({ apiKey: requireApiKey(provider, env, catalog), baseURL: url, fetch: withoutNativeToolsFetch("generate-content", fetch) }).languageModel(model),
                reasoningResponseProviderOptions: {
                    google: { thinkingConfig: { includeThoughts: true } },
                },
                requestControls: { namespace: "google", serviceTier: true, logprobs: false },
                catalog,
            };
        case "@ai-sdk/anthropic":
            return {
                languageModel: (fetch) => createAnthropic({ apiKey: requireApiKey(provider, env, catalog), baseURL: url, fetch: withoutNativeToolsFetch("messages", fetch) }).languageModel(model),
                additiveReasoningProvider: "anthropic",
                requestControls: { namespace: "anthropic", serviceTier: true, logprobs: false },
                catalog,
            };
        case "@ai-sdk/amazon-bedrock":
            return {
                languageModel: (fetch) => createAmazonBedrock({
                    fetch,
                    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
                    accessKeyId: env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
                    sessionToken: env.AWS_SESSION_TOKEN,
                    apiKey: env.AWS_BEARER_TOKEN_BEDROCK,
                    baseURL: url,
                }).languageModel(model),
                ...(model.includes("anthropic")
                    ? { additiveReasoningProvider: "bedrock" as const }
                    : {}),
                requestControls: { namespace: "bedrock", serviceTier: true, logprobs: false },
                catalog,
            };
        case "@openrouter/ai-sdk-provider":
            return {
                languageModel: (fetch) => createOpenRouter({
                    apiKey: requireApiKey(provider, env, catalog),
                    baseURL: url,
                    fetch: withoutNativeToolsFetch("openai", fetch),
                    ...attribution,
                }).languageModel(model),
                ...(normalizeCost === undefined ? {} : { normalizeCost }),
                requestControls: { namespace: "openrouter", serviceTier: false, logprobs: false },
                catalog,
            };
        case "@ai-sdk/openai-compatible":
            if (url === undefined) throw new Error(`${provider} provider: Models.dev supplies no API URL and no base URL was configured`);
            const keyNames = configuredKeyNames(provider, env, catalog);
            const key = keyNames.length === 0 ? undefined : requireApiKey(provider, env, catalog);
            return {
                compatible: {
                    url: `${url}/chat/completions`,
                    headers: key === undefined
                        ? {}
                        : { Authorization: `Bearer ${key}` },
                },
                catalog,
            };
        default:
            throw new Error(`${provider} provider: Models.dev declares unsupported AI SDK package ${catalog.npm}`);
    }
};
