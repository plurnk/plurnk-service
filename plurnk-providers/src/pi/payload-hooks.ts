// {§provider-request-authority} Per-API outbound payload adjustments (`onPayload` hook).

import { isRecord } from "@plurnk/plurnk-contracts";
import type { CacheBreakpoints, PromptCacheStyle } from "../ModelProvider.ts";
import type RequestCapture from "../RequestCapture.ts";
import type { ChatMessage, ProviderModel, UserCachePrefix } from "../types.ts";
import {
    applyAnthropicPayloadAdjustments,
    applyBedrockPayloadAdjustments,
    applyInPlaceOpenAICacheMarkers,
    mapOpenAICompatibleMessages,
    mapOpenAIExplicitCacheMessages,
    mergeConsecutiveUserMessages,
} from "./cache-breakpoints.ts";
import {
    applyBedrockMediaSlots,
    normalizeOpenAICompletionsWireMedia,
    normalizeOpenAIResponsesWireMedia,
    type BedrockMediaSlot,
} from "./media.ts";

const adjustGooglePayloadContents = (contents: unknown[]): void => {
    for (let idx = 0; idx < contents.length; idx += 1) {
        const entry = contents[idx];
        if (!isRecord(entry) || entry.role !== "user" || !Array.isArray(entry.parts)) continue;
        const inlineMimeTypes = entry.parts.flatMap((part) =>
            isRecord(part) && isRecord(part.inlineData) && typeof part.inlineData.mimeType === "string"
                ? [part.inlineData.mimeType]
                : []);
        if (inlineMimeTypes.length > 0 && inlineMimeTypes.every((m) => !m.startsWith("image/"))) {
            for (const part of entry.parts) {
                if (isRecord(part) && part.text === "Tool result image:") {
                    part.text = "Tool result file:";
                }
            }
            const prev = idx > 0 ? contents[idx - 1] : undefined;
            if (isRecord(prev) && prev.role === "user" && Array.isArray(prev.parts)) {
                for (const p of prev.parts) {
                    if (isRecord(p) && isRecord(p.functionResponse) && isRecord(p.functionResponse.response)) {
                        for (const key of ["output", "error"]) {
                            if (p.functionResponse.response[key] === "(see attached image)") {
                                p.functionResponse.response[key] = "(see attached file)";
                            }
                        }
                    }
                }
            }
        }
        for (const part of entry.parts) {
            if (!isRecord(part) || !isRecord(part.functionResponse) || !isRecord(part.functionResponse.response)) {
                continue;
            }
            const fnParts = Array.isArray(part.functionResponse.parts) ? part.functionResponse.parts : [];
            const fnMimeTypes = fnParts.flatMap((fp) =>
                isRecord(fp) && isRecord(fp.inlineData) && typeof fp.inlineData.mimeType === "string"
                    ? [fp.inlineData.mimeType]
                    : []);
            if (fnMimeTypes.length > 0 && fnMimeTypes.every((m) => !m.startsWith("image/"))) {
                for (const key of ["output", "error"]) {
                    if (part.functionResponse.response[key] === "(see attached image)") {
                        part.functionResponse.response[key] = "(see attached file)";
                    }
                }
            }
        }
    }
    for (let i = 1; i < contents.length; i += 1) {
        const prev: unknown = contents[i - 1];
        const curr: unknown = contents[i];
        if (!isRecord(prev) || !isRecord(curr) || prev.role !== "user" || curr.role !== "user") continue;
        if (!Array.isArray(prev.parts) || !Array.isArray(curr.parts)) continue;
        const prevParts: unknown[] = prev.parts;
        const currParts: unknown[] = curr.parts;
        const lastFunctionResponsePart: unknown = prevParts.findLast(
            (part) => isRecord(part) && isRecord(part.functionResponse) && isRecord(part.functionResponse.response),
        );
        const currHasFunctionResponse = currParts.some((part) => isRecord(part) && isRecord(part.functionResponse));
        if (
            isRecord(lastFunctionResponsePart)
            && isRecord(lastFunctionResponsePart.functionResponse)
            && isRecord(lastFunctionResponsePart.functionResponse.response)
            && !currHasFunctionResponse
        ) {
            const fnResp: Record<string, unknown> = { ...lastFunctionResponsePart.functionResponse };
            const respObj: Record<string, unknown> = { ...lastFunctionResponsePart.functionResponse.response };
            const textChunks = currParts.flatMap((part) =>
                isRecord(part) && typeof part.text === "string" && part.text.length > 0 ? [part.text] : [],
            );
            if (textChunks.length > 0) {
                const respKey = "error" in respObj ? "error" : "output";
                const existing = typeof respObj[respKey] === "string" ? respObj[respKey] : "";
                const joined = textChunks.join("\n\n");
                respObj[respKey] = existing.length > 0 ? `${existing}\n\n${joined}` : joined;
                fnResp.response = respObj;
            }
            const inlineParts = currParts.filter((part) => isRecord(part) && isRecord(part.inlineData));
            if (inlineParts.length > 0) {
                const existingParts: unknown[] = Array.isArray(fnResp.parts) ? fnResp.parts : [];
                fnResp.parts = [...existingParts, ...inlineParts];
            }
            lastFunctionResponsePart.functionResponse = fnResp;
            contents.splice(i, 1);
            i -= 1;
            continue;
        }
        prev.parts = [...prevParts, ...currParts];
        contents.splice(i, 1);
        i -= 1;
    }
    for (const entry of contents) {
        if (isRecord(entry) && entry.role === "model" && Array.isArray(entry.parts)) {
            const firstFunctionCall = entry.parts.find((part) => isRecord(part) && isRecord(part.functionCall));
            if (isRecord(firstFunctionCall)) {
                const firstHasSignature = typeof firstFunctionCall.thoughtSignature === "string"
                    && firstFunctionCall.thoughtSignature.length > 0;
                if (!firstHasSignature) {
                    for (const part of entry.parts) {
                        if (isRecord(part) && isRecord(part.functionCall)) {
                            delete part.thoughtSignature;
                        }
                    }
                    firstFunctionCall.thoughtSignature = "skip_thought_signature_validator";
                }
            }
        }
    }
};

export interface PayloadHookConfig {
    readonly effectiveModel: ProviderModel;
    readonly callKind: "emission" | "bare";
    readonly messages: readonly ChatMessage[];
    readonly promptCacheStyle?: PromptCacheStyle;
    readonly cacheBreakpoints: CacheBreakpoints | undefined;
    readonly userCachePrefixes?: readonly (UserCachePrefix | undefined)[];
    readonly resolvedControls: { readonly serviceTier?: string; readonly topLogprobs?: number };
    readonly topP?: number;
    readonly topK?: number;
    readonly presencePenalty?: number;
    readonly frequencyPenalty?: number;
    readonly stopSequences?: readonly string[];
    readonly seed?: number;
    readonly bedrockMediaSlots: readonly BedrockMediaSlot[];
    readonly capture?: RequestCapture;
}

export const createPiPayloadHook = (cfg: PayloadHookConfig) => async (payload: unknown): Promise<Record<string, unknown>> => {
    const {
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
    } = cfg;
    const transformed = effectiveModel.onPayload !== undefined
        ? await effectiveModel.onPayload(payload, effectiveModel)
        : payload;
    const params = isRecord(transformed) ? { ...transformed } : {};
    // {§provider-request-authority} — `"bare"` calls strip tool fields, and an empty `tools: []` array is never sent.
    if (callKind === "bare") {
        for (const field of ["tools", "tool_choice", "toolConfig", "functions", "function_call", "parallel_tool_calls"]) {
            delete params[field];
        }
    } else if (Array.isArray(params.tools) && params.tools.length === 0) {
        delete params.tools;
    }

    if (effectiveModel.api === "openai-completions") {
        const hasToolMessages = messages.some((m) => m.role === "tool" || (m.toolCalls?.length ?? 0) > 0);
        const hasNonImageFile = messages.some((m) =>
            Array.isArray(m.content) && m.content.some((p) => p.type === "file" && !p.mediaType.startsWith("image/")));
        if (promptCacheStyle === "openai-explicit") {
            params.prompt_cache_options = { mode: "explicit" };
            if (hasToolMessages && Array.isArray(params.messages)) {
                normalizeOpenAICompletionsWireMedia(params.messages);
                applyInPlaceOpenAICacheMarkers({
                    wireMessages: params.messages,
                    messages,
                    cacheBreakpoints,
                    userCachePrefixes,
                    markerField: "prompt_cache_breakpoint",
                    markerValue: { mode: "explicit" },
                });
            } else if (cacheBreakpoints !== undefined || hasNonImageFile) {
                params.messages = mapOpenAIExplicitCacheMessages(messages, cacheBreakpoints, userCachePrefixes);
            } else if (messages[0]?.role === "system" && Array.isArray(params.messages)) {
                const first: unknown = params.messages[0];
                if (!isRecord(first) || (first.role !== "system" && first.role !== "developer")) {
                    params.messages.unshift({ role: "system", content: "" });
                }
            }
        } else if (hasToolMessages && Array.isArray(params.messages)) {
            normalizeOpenAICompletionsWireMedia(params.messages);
            if (cacheBreakpoints !== undefined) {
                applyInPlaceOpenAICacheMarkers({
                    wireMessages: params.messages,
                    messages,
                    cacheBreakpoints,
                    userCachePrefixes,
                    markerField: "cache_control",
                    markerValue: { type: "ephemeral" },
                });
            }
        } else if (cacheBreakpoints !== undefined || hasNonImageFile) {
            params.messages = mapOpenAICompatibleMessages(messages, cacheBreakpoints, userCachePrefixes);
        } else if (messages[0]?.role === "system" && Array.isArray(params.messages)) {
            const first: unknown = params.messages[0];
            if (!isRecord(first) || (first.role !== "system" && first.role !== "developer")) {
                params.messages.unshift({ role: "system", content: "" });
            }
        }
    } else if (effectiveModel.api === "openai-responses") {
        if (Array.isArray(params.input)) {
            normalizeOpenAIResponsesWireMedia(params.input);
        }
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
        if (Array.isArray(params.messages)) {
            mergeConsecutiveUserMessages(params.messages, (text) => ({ type: "text", text }));
        }
        applyAnthropicPayloadAdjustments(params, messages, cacheBreakpoints, userCachePrefixes, resolvedControls.serviceTier);
    } else if (effectiveModel.api === "google-generative-ai") {
        const config: Record<string, unknown> = isRecord(params.config) ? { ...params.config } : {};
        if (callKind === "bare") {
            delete config.tools;
            delete config.toolConfig;
        }
        if (Array.isArray(params.contents)) {
            adjustGooglePayloadContents(params.contents);
        }
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
        if (callKind === "bare") {
            delete params.toolConfig;
        }
        if (Array.isArray(params.messages)) {
            mergeConsecutiveUserMessages(params.messages, (text) => ({ text }));
            applyBedrockMediaSlots(params.messages, bedrockMediaSlots);
        }
        applyBedrockPayloadAdjustments(params, messages, cacheBreakpoints, userCachePrefixes);
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
    return params;
};
