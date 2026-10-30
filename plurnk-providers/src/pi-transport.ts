// {§provider-sdk-boundary} {§provider-request-authority} Vendor transport adapter over @earendil-works/pi-ai
// and OpenAI-compatible HTTP endpoints (#1305, #1313).

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
import { isRecord } from "@plurnk/plurnk-contracts";
import { outboundFetch, syncAmbientHttp } from "@plurnk/plurnk-meta";
import { APICallError } from "./errors.ts";
import { withoutNativeTools } from "./native-tools.ts";
import { nativeFixedEffort } from "./reasoning-effort.ts";
import type ModelRequestBody from "./ModelRequestBody.ts";
import type RequestCapture from "./RequestCapture.ts";
import type { EffortSetting } from "./env.ts";
import type { CacheAffinity, NativeEffort, ProviderFetch } from "./ModelProvider.ts";
import {
    abortFailure,
    attachFailureEvidence,
    collectChunkForensics,
    extractFromAssistantMessage,
    serializeError,
    toUsageFromPiMessage,
} from "./stream-forensics.ts";
import type {
    ChatMessage,
    Effort,
    ProviderAttemptFinishReason,
    ProviderChargeEvidence,
    ProviderModel,
    ProviderRequestCapacity,
    ProviderUsage,
    TokenLogprob,
} from "./types.ts";

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

export interface PiTransportOptions {
    readonly model: string;
    readonly source: string;
    readonly url: string | undefined;
    readonly providerModel: ProviderModel | undefined;
    readonly fetch: ProviderFetch;
    readonly requestHeaders: Record<string, string>;
    readonly messages: readonly ChatMessage[];
    readonly sessionId: string;
    readonly operationSignal: AbortSignal | undefined;
    readonly requestSampling: Record<string, unknown>;
    readonly body: Record<string, unknown>;
    readonly effectiveMaxOutputTokens: number | undefined;
    readonly nativeReasoningBudget: number | null;
    readonly capacity: ProviderRequestCapacity;
    readonly requestBody: ModelRequestBody;
    readonly effort: EffortSetting;
    readonly adaptiveEffort: NativeEffort | "provider-default";
    readonly nativeAdaptiveThinking: boolean;
    readonly reasoningRequestBody: ((mode: Effort, reasoningBudget: number | null) => Record<string, unknown>) | undefined;
    readonly systemCacheBreakpoint: boolean;
    readonly cacheAffinity: CacheAffinity | undefined;
    readonly resolvedControls: { readonly serviceTier?: string; readonly topLogprobs?: number };
    readonly rawBody: boolean;
    readonly capture: RequestCapture | undefined;
    readonly reasoningStepDown?: number;
    readonly observers: {
        readonly observeReasoning?: (delta: string) => void;
        readonly observeText?: (delta: string) => void;
    };
}

export interface PiTransportStreamResult {
    readonly id: string | undefined;
    readonly model: string;
    content: string;
    reasoning: string;
    readonly reasoningProjected: boolean;
    readonly finishReason: ProviderAttemptFinishReason;
    readonly rawFinishReason?: string;
    readonly usage: ProviderUsage | undefined;
    readonly chargeEvidence: ProviderChargeEvidence;
    readonly logprobs: TokenLogprob[];
    readonly metadata: Record<string, unknown>;
    readonly wire: {
        readonly chunks: number;
        readonly emptyChunks: number;
        readonly fields: Record<string, unknown>;
        readonly channels: Record<string, string>;
        readonly toolCalls: { index: number; id: string; type: string; name: string; arguments: string }[];
        readonly unmappedChunks: never[];
    };
    readonly rawBody?: unknown[];
}

export const executePiTransportStream = async (opts: PiTransportOptions): Promise<PiTransportStreamResult> => {
    const {
        model,
        source,
        url,
        providerModel,
        fetch: configuredFetch,
        requestHeaders,
        messages,
        sessionId,
        operationSignal,
        requestSampling,
        body,
        effectiveMaxOutputTokens,
        nativeReasoningBudget,
        capacity,
        requestBody,
        effort,
        adaptiveEffort,
        nativeAdaptiveThinking,
        reasoningRequestBody,
        systemCacheBreakpoint,
        cacheAffinity,
        resolvedControls,
        rawBody,
        capture,
        reasoningStepDown = 0,
        observers,
    } = opts;

    const effectiveModel: ProviderModel = providerModel ?? {
        id: model,
        api: "openai-completions",
        provider: source,
        baseUrl: url!.replace(/\/chat\/completions\/?$/, ""),
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
    let requestUrl = url ?? effectiveModel.baseUrl;
    let requestBodyValues: unknown;

    const baseFetch = capture?.fetch(configuredFetch ?? outboundFetch) ?? configuredFetch ?? outboundFetch;
    const customFetch: ProviderFetch = async (input, init) => {
        const effectiveInput = providerModel === undefined && url !== undefined
            ? url
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
    const maxTokens = providerModel === undefined
        ? effectiveMaxOutputTokens
        : requestBody.nativeMaxOutputTokens(capacity.outputBudget, nativeReasoningBudget);
    const reasoning = providerModel === undefined || reasoningRequestBody !== undefined
        ? "provider-default"
        : effort.mode === "off"
            ? "none"
            : effort.mode === "adaptive"
                ? adaptiveEffort
                : nativeFixedEffort(effort.mode);

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
            if (systemCacheBreakpoint
                || messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "file" && !p.mediaType.startsWith("image/")))) {
                params.messages = mapOpenAICompatibleMessages(messages, systemCacheBreakpoint);
            } else if (messages[0]?.role === "system" && Array.isArray(params.messages)) {
                const first: unknown = params.messages[0];
                if (!isRecord(first) || (first.role !== "system" && first.role !== "developer")) {
                    params.messages.unshift({ role: "system", content: "" });
                }
            }
            if (providerModel === undefined) {
                for (const [key, value] of Object.entries(body)) {
                    if (value === undefined) delete params[key];
                    else params[key] = value;
                }
            } else {
                if (reasoningRequestBody !== undefined) {
                    Object.assign(params, reasoningRequestBody(effort.mode, capacity.reasoningBudget));
                }
                if (cacheAffinity?.target === "body") {
                    params[cacheAffinity.name] = sessionId;
                }
                if (resolvedControls.topLogprobs !== undefined) {
                    params.logprobs = true;
                    params.top_logprobs = resolvedControls.topLogprobs;
                }
                if (resolvedControls.serviceTier !== undefined) {
                    params.service_tier = resolvedControls.serviceTier;
                }
            }
        } else if (effectiveModel.api === "openai-responses") {
            if (topP !== undefined) params.top_p = topP;
            if (cacheAffinity?.target === "body") {
                params[cacheAffinity.name] = sessionId;
            }
            if (resolvedControls.serviceTier !== undefined) {
                params.service_tier = resolvedControls.serviceTier;
            }
            if (resolvedControls.topLogprobs !== undefined) {
                const existingInclude = Array.isArray(params.include)
                    ? params.include.filter((item): item is string => typeof item === "string")
                    : [];
                if (!existingInclude.includes("message.output_text.logprobs")) {
                    params.include = [...existingInclude, "message.output_text.logprobs"];
                }
                params.top_logprobs = resolvedControls.topLogprobs;
            }
        } else if (effectiveModel.api === "anthropic-messages") {
            if (topP !== undefined) params.top_p = topP;
            if (topK !== undefined) params.top_k = topK;
            if (stopSequences !== undefined) params.stop_sequences = stopSequences;
            applyAnthropicPayloadAdjustments(params, messages, systemCacheBreakpoint, resolvedControls.serviceTier);
        } else if (effectiveModel.api === "google-generative-ai") {
            const config: Record<string, unknown> = isRecord(params.config) ? { ...params.config } : {};
            if (topP !== undefined) config.topP = topP;
            if (topK !== undefined) config.topK = topK;
            if (presencePenalty !== undefined) config.presencePenalty = presencePenalty;
            if (frequencyPenalty !== undefined) config.frequencyPenalty = frequencyPenalty;
            if (stopSequences !== undefined) config.stopSequences = stopSequences;
            if (seed !== undefined) config.seed = seed;
            if (resolvedControls.serviceTier !== undefined) {
                config.serviceTier = resolvedControls.serviceTier;
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
            if (resolvedControls.serviceTier !== undefined) {
                params.serviceTier = { type: resolvedControls.serviceTier };
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
                const reasoningEffort = providerModel === undefined || reasoning === "none" || reasoning === "provider-default"
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
                        ...(nativeAdaptiveThinking ? { compat: { forceAdaptiveThinking: true } } : {}),
                    },
                    context,
                    {
                        ...commonOptions,
                        fetch: customFetch,
                        apiKey: effectiveModel.apiKey ?? "plurnk-unset",
                        cacheRetention: "none",
                        ...(reasoning === "none"
                            ? { thinkingEnabled: false }
                            : nativeAdaptiveThinking
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
                const googleLevels = ["HIGH", "MEDIUM", "LOW", "MINIMAL"] as const;
                const baseLevel: typeof googleLevels[number] = reasoning === "minimal"
                    ? "MINIMAL"
                    : reasoning === "low"
                        ? "LOW"
                        : reasoning === "medium"
                            ? "MEDIUM"
                            : "HIGH";
                const steppedIndex = Math.min(
                    googleLevels.length - 1,
                    googleLevels.indexOf(baseLevel) + reasoningStepDown,
                );
                const googleLevel = googleLevels[steppedIndex];
                const rawBudget = nativeReasoningBudget ?? capacity.reasoningBudget;
                const reservedVisible = capacity.outputFloor !== null
                    && maxTokens !== undefined
                    && maxTokens > capacity.outputFloor
                    ? capacity.outputFloor
                    : 1;
                const maxThinkingBudget = maxTokens !== undefined
                    ? Math.max(1, maxTokens - reservedVisible)
                    : null;
                const boundedBudget = rawBudget === null
                    ? null
                    : maxThinkingBudget === null
                        ? rawBudget
                        : Math.min(rawBudget, maxThinkingBudget);
                const steppedBudget = boundedBudget === null
                    ? null
                    : Math.max(1, Math.floor(boundedBudget / 2 ** reasoningStepDown));
                const googleThinking = reasoning === "none"
                    ? { enabled: false }
                    : steppedBudget !== null
                        ? { enabled: true, budgetTokens: steppedBudget }
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
    return {
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
        ...(rawBody ? { rawBody: rawChunks } : {}),
    };
};
