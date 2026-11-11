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
import {
    getBuiltinModels,
    getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { headersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { isRecord } from "@plurnk/plurnk-contracts";
import { outboundFetch, syncAmbientHttp } from "@plurnk/plurnk-meta";
import { APICallError } from "./errors.ts";
import { nativeFixedEffort } from "./reasoning-effort.ts";
import type ModelRequestBody from "./ModelRequestBody.ts";
import type RequestCapture from "./RequestCapture.ts";
import type { EffortSetting } from "./env.ts";
import type { CacheAffinity, CacheBreakpoints, NativeEffort, ProviderFetch } from "./ModelProvider.ts";
import {
    abortFailure,
    attachFailureEvidence,
    collectChunkForensics,
    extractFromAssistantMessage,
    serializeError,
    toUsageFromPiMessage,
} from "./stream-forensics.ts";
import type {
    ChatContentPart,
    ChatMessage,
    Effort,
    FinalUserCachePrefix,
    ProviderAttemptFinishReason,
    ProviderChargeEvidence,
    ProviderModel,
    ProviderRequestCapacity,
    ProviderUsage,
    TokenLogprob,
} from "./types.ts";

const PI_BUILTIN_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
    "alibaba": "qwen-token-plan",
    "alibaba-cn": "qwen-token-plan-cn",
    "fireworks-ai": "fireworks",
    "togetherai": "together",
    "zai-coding-plan": "zai",
};

const lookupPiBuiltinCompat = (
    providerId: string,
    modelId: string,
): Pick<NonNullable<ProviderModel["compat"]>, "requiresReasoningContentOnAssistantMessages" | "zaiToolStream"> => {
    const targetProvider = PI_BUILTIN_PROVIDER_ALIASES[providerId] ?? providerId;
    const builtinProvider = getBuiltinProviders().find((candidate) => candidate === targetProvider);
    if (builtinProvider === undefined) return {};
    const builtin = getBuiltinModels(builtinProvider).find((candidate) => candidate.id === modelId);
    const rawCompat: unknown = builtin?.compat;
    const compat = isRecord(rawCompat) ? rawCompat : undefined;
    return {
        ...(typeof compat?.requiresReasoningContentOnAssistantMessages === "boolean"
            ? { requiresReasoningContentOnAssistantMessages: compat.requiresReasoningContentOnAssistantMessages }
            : {}),
        ...(typeof compat?.zaiToolStream === "boolean"
            ? { zaiToolStream: compat.zaiToolStream }
            : {}),
    };
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

const hasWireContent = (message: ChatMessage): boolean =>
    typeof message.content === "string"
        ? message.content.trim().length > 0
        : message.content.some((part) => part.type !== "text" || part.text.trim().length > 0);

const countWireParts = (parts: readonly ChatContentPart[], limit: number): number => {
    let count = 0;
    const end = Math.min(limit, parts.length);
    for (let i = 0; i < end; i += 1) {
        const part = parts[i];
        if (part.type !== "text" || part.text.trim().length > 0) count += 1;
    }
    return count;
};

const toOpenAIPart = (part: ChatContentPart): Record<string, unknown> => {
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
};

const withEphemeralCacheControl = (parts: Record<string, unknown>[], atIndex: number): Record<string, unknown>[] => {
    if (atIndex >= 0 && atIndex < parts.length) {
        parts[atIndex] = { ...parts[atIndex], cache_control: { type: "ephemeral" } };
    }
    return parts;
};

const mapOpenAICompatibleMessages = (
    messages: readonly ChatMessage[],
    cacheBreakpoints: CacheBreakpoints | undefined,
    finalUserCachePrefix?: FinalUserCachePrefix,
): readonly Record<string, unknown>[] => {
    let lastLeadingSystemIndex = -1;
    let firstNonSystemIndex = messages.length;
    for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].role !== "system") {
            firstNonSystemIndex = i;
            break;
        }
        if (cacheBreakpoints !== undefined && hasWireContent(messages[i])) {
            lastLeadingSystemIndex = i;
        }
    }
    let penultimateNonSystemIndex = -1;
    let finalUserIndex = -1;
    if (cacheBreakpoints === "conversation") {
        const nonSystemIndices: number[] = [];
        for (let i = firstNonSystemIndex; i < messages.length; i += 1) {
            if (hasWireContent(messages[i])) nonSystemIndices.push(i);
        }
        if (nonSystemIndices.length >= 2) {
            penultimateNonSystemIndex = nonSystemIndices[nonSystemIndices.length - 2];
        }
        const lastIdx = nonSystemIndices.at(-1);
        if (lastIdx !== undefined && messages[lastIdx].role === "user") {
            finalUserIndex = lastIdx;
        }
    }
    return messages.map((message, index) => {
        if (index === lastLeadingSystemIndex || index === penultimateNonSystemIndex) {
            const parts = typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content.map(toOpenAIPart);
            return {
                role: message.role,
                content: withEphemeralCacheControl(parts, parts.length - 1),
            };
        }
        if (index === finalUserIndex) {
            if (finalUserCachePrefix === undefined) {
                const parts = typeof message.content === "string"
                    ? [{ type: "text", text: message.content }]
                    : message.content.map(toOpenAIPart);
                return {
                    role: message.role,
                    content: withEphemeralCacheControl(parts, parts.length - 1),
                };
            }
            if (finalUserCachePrefix.kind === "chars" && typeof message.content === "string") {
                if (finalUserCachePrefix.length <= 0) {
                    return { role: message.role, content: message.content };
                }
                if (finalUserCachePrefix.length >= message.content.length) {
                    return {
                        role: message.role,
                        content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }],
                    };
                }
                const durable = message.content.slice(0, finalUserCachePrefix.length);
                const volatile = message.content.slice(finalUserCachePrefix.length);
                if (durable.trim().length === 0) {
                    return { role: message.role, content: message.content };
                }
                return {
                    role: message.role,
                    content: volatile.trim().length > 0
                        ? [
                            { type: "text", text: durable, cache_control: { type: "ephemeral" } },
                            { type: "text", text: volatile },
                        ]
                        : [{ type: "text", text: durable, cache_control: { type: "ephemeral" } }],
                };
            }
            if (finalUserCachePrefix.kind === "parts" && Array.isArray(message.content)) {
                const parts = message.content.map(toOpenAIPart);
                const targetIndex = Math.min(finalUserCachePrefix.count, parts.length) - 1;
                return {
                    role: message.role,
                    content: finalUserCachePrefix.count > 0
                        ? withEphemeralCacheControl(parts, targetIndex)
                        : parts,
                };
            }
        }
        if (typeof message.content === "string") {
            return { role: message.role, content: message.content };
        }
        return {
            role: message.role,
            content: message.content.map(toOpenAIPart),
        };
    });
};

const markAnthropicMessageEnd = (wireMsg: unknown): void => {
    if (!isRecord(wireMsg)) return;
    if (typeof wireMsg.content === "string") {
        if (wireMsg.content.trim().length > 0) {
            wireMsg.content = [{ type: "text", text: wireMsg.content, cache_control: { type: "ephemeral" } }];
        }
        return;
    }
    if (Array.isArray(wireMsg.content) && wireMsg.content.length > 0) {
        const last = wireMsg.content.at(-1);
        if (isRecord(last)) {
            last.cache_control = { type: "ephemeral" };
        }
    }
};

const applyAnthropicPayloadAdjustments = (
    params: Record<string, unknown>,
    messages: readonly ChatMessage[],
    cacheBreakpoints: CacheBreakpoints | undefined,
    finalUserCachePrefix: FinalUserCachePrefix | undefined,
    serviceTier: string | undefined,
): void => {
    if (serviceTier !== undefined) {
        params.service_tier = serviceTier;
    }
    if (cacheBreakpoints !== undefined && Array.isArray(params.system) && params.system.length > 0) {
        const last = params.system.at(-1);
        if (isRecord(last)) {
            last.cache_control = { type: "ephemeral" };
        }
    }
    const wireMessages = Array.isArray(params.messages) ? params.messages : undefined;
    if (wireMessages === undefined) return;
    const effectiveNonSystem = messages.filter((m) => m.role !== "system" && hasWireContent(m));
    for (let i = 0; i < Math.min(wireMessages.length, effectiveNonSystem.length); i += 1) {
        const sourceMsg = effectiveNonSystem[i];
        const wireMsg = wireMessages[i];
        if (!Array.isArray(sourceMsg.content) || !isRecord(wireMsg) || !Array.isArray(wireMsg.content)) continue;
        const nonBlankSourceParts = sourceMsg.content.filter((p) => p.type !== "text" || p.text.trim().length > 0);
        for (let j = 0; j < Math.min(nonBlankSourceParts.length, wireMsg.content.length); j += 1) {
            const sourcePart = nonBlankSourceParts[j];
            const wireBlock = wireMsg.content[j];
            if (sourcePart.type === "file"
                && sourcePart.mediaType === "application/pdf"
                && isRecord(wireBlock)
                && wireBlock.type === "image") {
                wireBlock.type = "document";
            }
        }
    }
    if (cacheBreakpoints !== "conversation" || wireMessages.length === 0) return;
    if (wireMessages.length >= 2) {
        markAnthropicMessageEnd(wireMessages[wireMessages.length - 2]);
    }
    const lastWire = wireMessages.at(-1);
    const lastSource = effectiveNonSystem.at(-1);
    if (lastSource?.role !== "user" || !isRecord(lastWire) || lastWire.role !== "user") return;
    if (finalUserCachePrefix === undefined) {
        markAnthropicMessageEnd(lastWire);
        return;
    }
    if (finalUserCachePrefix.kind === "chars" && typeof lastSource.content === "string") {
        if (finalUserCachePrefix.length <= 0) return;
        if (finalUserCachePrefix.length >= lastSource.content.length) {
            markAnthropicMessageEnd(lastWire);
            return;
        }
        const durable = lastSource.content.slice(0, finalUserCachePrefix.length);
        const volatile = lastSource.content.slice(finalUserCachePrefix.length);
        if (durable.trim().length === 0) return;
        lastWire.content = volatile.trim().length > 0
            ? [
                { type: "text", text: durable, cache_control: { type: "ephemeral" } },
                { type: "text", text: volatile },
            ]
            : [{ type: "text", text: durable, cache_control: { type: "ephemeral" } }];
        return;
    }
    if (finalUserCachePrefix.kind === "parts" && Array.isArray(lastSource.content) && Array.isArray(lastWire.content)) {
        const k = countWireParts(lastSource.content, finalUserCachePrefix.count);
        if (k > 0 && k <= lastWire.content.length) {
            const target = lastWire.content[k - 1];
            if (isRecord(target)) target.cache_control = { type: "ephemeral" };
        }
    }
};

const appendBedrockCachePoint = (wireMsg: unknown, sourceMsg: ChatMessage | undefined): void => {
    if (sourceMsg === undefined || !hasWireContent(sourceMsg)) return;
    if (!isRecord(wireMsg) || !Array.isArray(wireMsg.content) || wireMsg.content.length === 0) return;
    wireMsg.content = [...wireMsg.content, { cachePoint: { type: "default" } }];
};

const applyBedrockPayloadAdjustments = (
    params: Record<string, unknown>,
    messages: readonly ChatMessage[],
    cacheBreakpoints: CacheBreakpoints | undefined,
    finalUserCachePrefix: FinalUserCachePrefix | undefined,
): void => {
    if (cacheBreakpoints === undefined) return;
    if (Array.isArray(params.system) && params.system.length > 0) {
        params.system = [...params.system, { cachePoint: { type: "default" } }];
    }
    if (cacheBreakpoints !== "conversation") return;
    const wireMessages = Array.isArray(params.messages) ? params.messages : undefined;
    if (wireMessages === undefined || wireMessages.length === 0) return;
    const bedrockNonSystem = messages.filter((m) => m.role === "user" || (m.role === "assistant" && hasWireContent(m)));
    if (wireMessages.length >= 2) {
        appendBedrockCachePoint(wireMessages[wireMessages.length - 2], bedrockNonSystem[bedrockNonSystem.length - 2]);
    }
    const lastWire = wireMessages.at(-1);
    const lastSource = bedrockNonSystem.at(-1);
    if (lastSource?.role !== "user" || !hasWireContent(lastSource) || !isRecord(lastWire) || lastWire.role !== "user" || !Array.isArray(lastWire.content)) {
        return;
    }
    if (finalUserCachePrefix === undefined) {
        appendBedrockCachePoint(lastWire, lastSource);
        return;
    }
    if (finalUserCachePrefix.kind === "chars" && typeof lastSource.content === "string") {
        if (finalUserCachePrefix.length <= 0) return;
        if (finalUserCachePrefix.length >= lastSource.content.length) {
            appendBedrockCachePoint(lastWire, lastSource);
            return;
        }
        const durable = lastSource.content.slice(0, finalUserCachePrefix.length);
        const volatile = lastSource.content.slice(finalUserCachePrefix.length);
        if (durable.trim().length === 0) return;
        lastWire.content = volatile.trim().length > 0
            ? [{ text: durable }, { cachePoint: { type: "default" } }, { text: volatile }]
            : [{ text: durable }, { cachePoint: { type: "default" } }];
        return;
    }
    if (finalUserCachePrefix.kind === "parts" && Array.isArray(lastSource.content)) {
        const k = countWireParts(lastSource.content, finalUserCachePrefix.count);
        if (k > 0 && k <= lastWire.content.length) {
            lastWire.content = [
                ...lastWire.content.slice(0, k),
                { cachePoint: { type: "default" } },
                ...lastWire.content.slice(k),
            ];
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
    readonly outputTokenField?: "max_tokens" | "max_completion_tokens";
    readonly effectiveMaxOutputTokens: number | undefined;
    readonly nativeReasoningBudget: number | null;
    readonly capacity: ProviderRequestCapacity;
    readonly requestBody: ModelRequestBody;
    readonly effort: EffortSetting;
    readonly adaptiveEffort: NativeEffort | "provider-default";
    readonly nativeAdaptiveThinking: boolean;
    readonly reasoningRequestBody: ((mode: Effort, reasoningBudget: number | null) => Record<string, unknown>) | undefined;
    readonly cacheBreakpoints: CacheBreakpoints | undefined;
    readonly finalUserCachePrefix?: FinalUserCachePrefix;
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
    readonly exceededOutputTokens?: number;
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
        outputTokenField = "max_tokens",
        effectiveMaxOutputTokens,
        nativeReasoningBudget,
        capacity,
        requestBody,
        effort,
        adaptiveEffort,
        nativeAdaptiveThinking,
        reasoningRequestBody,
        cacheBreakpoints,
        finalUserCachePrefix,
        cacheAffinity,
        resolvedControls,
        rawBody,
        capture,
        reasoningStepDown = 0,
        observers,
    } = opts;

    const providerId = source.replace(/^provider:/, "");
    const effectiveModel: ProviderModel = providerModel ?? {
        id: model,
        api: "openai-completions",
        provider: providerId,
        baseUrl: url!.replace(/\/chat\/completions\/?$/, ""),
        compat: {
            ...lookupPiBuiltinCompat(providerId, model),
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsUsageInStreaming: true,
            supportsFinishReason: true,
            maxTokensField: outputTokenField,
            thinkingFormat: "openai",
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

    const streamAbort = new AbortController();
    const streamSignal = operationSignal === undefined
        ? streamAbort.signal
        : AbortSignal.any([operationSignal, streamAbort.signal]);
    const commonOptions = {
        signal: streamSignal,
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
            if (cacheBreakpoints !== undefined
                || messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "file" && !p.mediaType.startsWith("image/")))) {
                params.messages = mapOpenAICompatibleMessages(messages, cacheBreakpoints, finalUserCachePrefix);
            } else if (messages[0]?.role === "system" && Array.isArray(params.messages)) {
                const first: unknown = params.messages[0];
                if (!isRecord(first) || (first.role !== "system" && first.role !== "developer")) {
                    params.messages.unshift({ role: "system", content: "" });
                }
            }
        } else if (effectiveModel.api === "openai-responses") {
            if (resolvedControls.topLogprobs !== undefined) {
                const existingInclude = Array.isArray(params.include)
                    ? params.include.filter((item): item is string => typeof item === "string")
                    : [];
                if (!existingInclude.includes("message.output_text.logprobs")) {
                    params.include = [...existingInclude, "message.output_text.logprobs"];
                }
            }
        } else if (effectiveModel.api === "anthropic-messages") {
            if (topP !== undefined) params.top_p = topP;
            if (topK !== undefined) params.top_k = topK;
            if (stopSequences !== undefined) params.stop_sequences = stopSequences;
            applyAnthropicPayloadAdjustments(params, messages, cacheBreakpoints, finalUserCachePrefix, resolvedControls.serviceTier);
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
            params.config = config;
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
            applyBedrockPayloadAdjustments(params, messages, cacheBreakpoints, finalUserCachePrefix);
            try {
                capture?.record({
                    method: "POST",
                    origin: new URL(effectiveModel.baseUrl).origin,
                    body: JSON.stringify(params),
                });
            } catch {
                // ignore invalid URL
            }
        }
        requestBodyValues = params;
        return params;
    };

    const startStream = (): AssistantMessageEventStream => {
        switch (effectiveModel.api) {
            case "openai-completions": {
                const reasoningEffort = providerModel === undefined || reasoning === "none" || reasoning === "provider-default"
                    ? undefined
                    : reasoning;
                const samplingParams: Record<string, unknown> = providerModel === undefined
                    ? Object.fromEntries(
                        Object.entries(body).filter(([key, value]) =>
                            value !== undefined
                            && key !== "temperature"
                            && key !== "max_tokens"
                            && key !== "max_completion_tokens"),
                    )
                    : {
                        ...(topP === undefined ? {} : { top_p: topP }),
                        ...(topK !== undefined && effectiveModel.includeTopK === true ? { top_k: topK } : {}),
                        ...(presencePenalty === undefined ? {} : { presence_penalty: presencePenalty }),
                        ...(frequencyPenalty === undefined ? {} : { frequency_penalty: frequencyPenalty }),
                        ...(stopSequences === undefined ? {} : { stop: stopSequences }),
                        ...(seed === undefined ? {} : { seed }),
                        ...(reasoningRequestBody === undefined ? {} : reasoningRequestBody(effort.mode, capacity.reasoningBudget)),
                        ...(cacheAffinity?.target === "body" ? { [cacheAffinity.name]: sessionId } : {}),
                        ...(resolvedControls.topLogprobs === undefined ? {} : { logprobs: true, top_logprobs: resolvedControls.topLogprobs }),
                        ...(resolvedControls.serviceTier === undefined ? {} : { service_tier: resolvedControls.serviceTier }),
                    };
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
                        ...(Object.keys(samplingParams).length === 0 ? {} : { samplingParams }),
                        onPayload,
                    },
                );
            }
            case "openai-responses": {
                const reasoningEffort = reasoning === "none" || reasoning === "provider-default" ? undefined : reasoning;
                const samplingParams: Record<string, unknown> = {
                    ...(topP === undefined ? {} : { top_p: topP }),
                    ...(cacheAffinity?.target === "body" ? { [cacheAffinity.name]: sessionId } : {}),
                    ...(resolvedControls.topLogprobs === undefined ? {} : { top_logprobs: resolvedControls.topLogprobs }),
                    ...(resolvedControls.serviceTier === undefined ? {} : { service_tier: resolvedControls.serviceTier }),
                };
                return streamOpenAIResponses(buildPiModel("openai-responses"), context, {
                    ...commonOptions,
                    fetch: customFetch,
                    apiKey: effectiveModel.apiKey ?? "plurnk-unset",
                    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                    ...(Object.keys(samplingParams).length === 0 ? {} : { samplingParams }),
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
                    cacheRetention: "none",
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

    const grantedOutput = capacity.responseMax ?? capacity.outputBudget;
    let outputObserved = false;
    let exceededOutputTokens: number | undefined;
    let finalMessage: AssistantMessage | undefined;
    let lastErrorMessage: AssistantMessage | undefined;
    let streamError: string | undefined;

    const checkRunawayOutput = (partial: AssistantMessage): boolean => {
        if (grantedOutput === null) return false;
        const midStreamOutputTokens = Math.max(
            partial.usage.output,
            Math.floor(estimateMessageTokens(partial) / 2),
        );
        if (midStreamOutputTokens <= grantedOutput) return false;
        exceededOutputTokens = midStreamOutputTokens;
        finalMessage = partial;
        streamAbort.abort();
        return true;
    };

    const stream = startStream();
    for await (const event of stream) {
        if (event.type === "text_delta" && event.delta.length > 0) {
            outputObserved = true;
            observers.observeText?.(event.delta);
            if (checkRunawayOutput(event.partial)) break;
        } else if (event.type === "thinking_delta" && event.delta.length > 0) {
            outputObserved = true;
            observers.observeReasoning?.(event.delta);
            if (checkRunawayOutput(event.partial)) break;
        } else if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
            outputObserved = true;
            if (checkRunawayOutput(event.partial)) break;
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
        finishReason: exceededOutputTokens !== undefined && messageInfo.finishReason === null
            ? "length"
            : messageInfo.finishReason,
        ...(messageInfo.rawFinishReason === undefined ? {} : { rawFinishReason: messageInfo.rawFinishReason }),
        usage,
        ...(exceededOutputTokens === undefined ? {} : { exceededOutputTokens }),
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
