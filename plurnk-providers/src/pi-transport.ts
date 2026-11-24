// {§provider-sdk-boundary} {§provider-request-authority} Vendor transport adapter over @earendil-works/pi-ai
// and OpenAI-compatible HTTP endpoints (#1305, #1313).

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamBedrockConverseStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as streamGoogleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { headersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { MAX_TIMER_MS } from "@plurnk/plurnk-contracts";
import { outboundFetch, syncAmbientHttp } from "@plurnk/plurnk-meta";
import type { EffortSetting } from "./env.ts";
import type {
    CacheAffinity,
    CacheBreakpoints,
    NativeEffort,
    PromptCacheStyle,
    ProviderFetch,
} from "./ModelProvider.ts";
import type ModelRequestBody from "./ModelRequestBody.ts";
import { formatCacheAffinityValue } from "./pi/cache-breakpoints.ts";
import { lookupPiBuiltinCompat, toPiContext } from "./pi/context.ts";
import { finalizePiTransportOutcome, type PiTransportStreamResult } from "./pi/forensics.ts";
import { toOpenAIChatMessages, type BedrockMediaSlot } from "./pi/media.ts";
import { createPiPayloadHook } from "./pi/payload-hooks.ts";
import { nativeFixedEffort } from "./reasoning-effort.ts";
import type RequestCapture from "./RequestCapture.ts";
import type {
    ChatMessage,
    Effort,
    ProviderModel,
    ProviderRequestCapacity,
    UserCachePrefix,
} from "./types.ts";

export { formatCacheAffinityValue, toOpenAIChatMessages, type PiTransportStreamResult };

const GOOGLE_FETCH_ROUTE_HEADER = "x-plurnk-google-fetch-route";
const activeGoogleFetchRoutes = new Map<string, ProviderFetch>();
let underlyingGlobalFetch: typeof globalThis.fetch | undefined;

const googleScopedFetch: typeof globalThis.fetch = (input, init) => {
    if (init?.headers !== undefined || input instanceof Request) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const routeId = headers.get(GOOGLE_FETCH_ROUTE_HEADER);
        if (routeId !== null) {
            headers.delete(GOOGLE_FETCH_ROUTE_HEADER);
            const routed = activeGoogleFetchRoutes.get(routeId);
            if (routed !== undefined) {
                return routed(input, { ...init, headers });
            }
        }
    }
    if (underlyingGlobalFetch !== undefined && underlyingGlobalFetch !== googleScopedFetch) {
        return underlyingGlobalFetch(input, init);
    }
    throw new TypeError("Google fetch router lost its underlying fetch implementation");
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
    readonly promptCacheStyle?: PromptCacheStyle;
    readonly userCachePrefixes?: readonly (UserCachePrefix | undefined)[];
    readonly cacheAffinity: CacheAffinity | undefined;
    readonly callKind?: "emission" | "bare";
    readonly resolvedControls: { readonly serviceTier?: string; readonly topLogprobs?: number };
    readonly rawBody: boolean;
    readonly capture: RequestCapture | undefined;
    readonly reasoningStepDown?: number;
    readonly observers: {
        readonly observeReasoning?: (delta: string) => void;
        readonly observeText?: (delta: string) => void;
    };
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
        promptCacheStyle,
        userCachePrefixes,
        cacheAffinity,
        callKind = "emission",
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
    const bedrockMediaSlots: BedrockMediaSlot[] = [];
    const context = toPiContext(messages, effectiveModel, callKind, bedrockMediaSlots);
    const rawChunks: unknown[] = [];
    let httpResponse: { status: number; headers: Record<string, string>; ok: boolean } | undefined;
    let httpErrorBody: string | undefined;
    let capturedTransportError: unknown;
    let requestUrl = url ?? effectiveModel.baseUrl;

    const baseFetch = capture?.fetch(configuredFetch ?? outboundFetch) ?? configuredFetch ?? outboundFetch;
    const customFetch: ProviderFetch = async (input, init) => {
        const effectiveInput = providerModel === undefined && url !== undefined ? url : input;
        requestUrl = typeof effectiveInput === "string"
            ? effectiveInput
            : effectiveInput instanceof URL
                ? effectiveInput.toString()
                : effectiveInput.url;
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
        timeoutMs: MAX_TIMER_MS,
        headers: requestHeaders,
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        onResponse: (res: { status: number; headers: Record<string, string> }) => {
            httpResponse ??= {
                status: res.status,
                headers: res.headers,
                ok: res.status >= 200 && res.status < 300,
            };
        },
        onProviderStreamEvent: (rawEvent: unknown) => {
            rawChunks.push(rawEvent);
        },
    };

    const onPayload = createPiPayloadHook({
        effectiveModel,
        callKind,
        messages,
        promptCacheStyle,
        cacheBreakpoints,
        userCachePrefixes,
        resolvedControls,
        topP,
        topK,
        presencePenalty,
        frequencyPenalty,
        stopSequences,
        seed,
        bedrockMediaSlots,
        capture,
    });

    let googleFetchRouteId: string | undefined;
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
                        ...(cacheAffinity?.target === "body" ? { [cacheAffinity.name]: formatCacheAffinityValue(cacheAffinity, sessionId) } : {}),
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
                        cacheRetention: "none",
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
                    ...(cacheAffinity?.target === "body" ? { [cacheAffinity.name]: formatCacheAffinityValue(cacheAffinity, sessionId) } : {}),
                    ...(resolvedControls.topLogprobs === undefined ? {} : { top_logprobs: resolvedControls.topLogprobs }),
                    ...(resolvedControls.serviceTier === undefined ? {} : { service_tier: resolvedControls.serviceTier }),
                };
                return streamOpenAIResponses(buildPiModel("openai-responses"), context, {
                    ...commonOptions,
                    fetch: customFetch,
                    apiKey: effectiveModel.apiKey ?? "plurnk-unset",
                    cacheRetention: "none",
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
                googleFetchRouteId = crypto.randomUUID();
                if (activeGoogleFetchRoutes.size === 0 && globalThis.fetch !== googleScopedFetch) {
                    underlyingGlobalFetch = globalThis.fetch;
                    globalThis.fetch = googleScopedFetch;
                }
                activeGoogleFetchRoutes.set(googleFetchRouteId, customFetch);
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
                            ? { enabled: true, level: googleLevel }
                            : undefined;
                return streamGoogleGenerativeAi(buildPiModel("google-generative-ai"), context, {
                    ...commonOptions,
                    headers: {
                        ...requestHeaders,
                        [GOOGLE_FETCH_ROUTE_HEADER]: googleFetchRouteId,
                    },
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
                const bedrockEnv = effectiveModel.env === undefined
                    ? undefined
                    : Object.fromEntries(
                        Object.entries(effectiveModel.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
                    );
                return streamBedrockConverseStream(buildPiModel("bedrock-converse-stream"), context, {
                    ...commonOptions,
                    cacheRetention: "none",
                    ...(effectiveModel.apiKey === undefined ? {} : { apiKey: effectiveModel.apiKey }),
                    ...(bedrockEnv === undefined ? {} : { env: bedrockEnv }),
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

    try {
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
    } finally {
        if (googleFetchRouteId !== undefined) {
            activeGoogleFetchRoutes.delete(googleFetchRouteId);
            if (activeGoogleFetchRoutes.size === 0 && underlyingGlobalFetch !== undefined) {
                if (globalThis.fetch === googleScopedFetch) {
                    globalThis.fetch = underlyingGlobalFetch;
                }
                underlyingGlobalFetch = undefined;
            }
        }
    }

    return finalizePiTransportOutcome({
        effectiveModel,
        requestUrl,
        rawChunks,
        httpResponse,
        httpErrorBody,
        capturedTransportError,
        operationSignal,
        outputObserved,
        exceededOutputTokens,
        finalMessage,
        lastErrorMessage,
        streamError,
        rawBody,
    });
};
