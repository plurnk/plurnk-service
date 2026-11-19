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
    type ThinkingContent,
    type ToolCall,
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
import { MAX_TIMER_MS, MCP_WIRE_TOOL, isRecord } from "@plurnk/plurnk-contracts";
import { outboundFetch, syncAmbientHttp } from "@plurnk/plurnk-meta";
import { ProviderHttpError } from "./errors.ts";
import { nativeFixedEffort } from "./reasoning-effort.ts";
import type ModelRequestBody from "./ModelRequestBody.ts";
import type RequestCapture from "./RequestCapture.ts";
import type { EffortSetting } from "./env.ts";
import type { CacheAffinity, CacheBreakpoints, NativeEffort, PromptCacheStyle, ProviderFetch } from "./ModelProvider.ts";
import {
    abortFailure,
    attachFailureEvidence,
    collectChunkForensics,
    extractFromAssistantMessage,
    serializeError,
    toUsageFromPiMessage,
} from "./stream-forensics.ts";
import type {
    AssistantMessageReplay,
    ChatContentPart,
    ChatMessage,
    Effort,
    ProviderAttemptFinishReason,
    ProviderChargeEvidence,
    ProviderModel,
    ProviderRequestCapacity,
    ProviderToolCall,
    ProviderUsage,
    TokenLogprob,
    UserCachePrefix,
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

const BEDROCK_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
]);

const BEDROCK_MEDIA_SENTINEL_PREFIX = "\0plurnk-bedrock-media:";
const BEDROCK_MEDIA_SENTINEL_SUFFIX = "\0";

interface BedrockMediaSlot {
    readonly mediaType: string;
    readonly data: Uint8Array;
}

const BEDROCK_ERROR_CODE_STATUS: Readonly<Record<string, number>> = {
    ValidationException: 400,
    UnrecognizedClientException: 401,
    ExpiredTokenException: 401,
    AccessDeniedException: 403,
    ResourceNotFoundException: 404,
    ModelTimeoutException: 408,
    ModelNotReadyException: 429,
    ThrottlingException: 429,
    TooManyRequestsException: 429,
    ServiceQuotaExceededException: 429,
    InternalServerException: 500,
    ModelErrorException: 500,
    ModelStreamErrorException: 500,
    ServiceUnavailableException: 503,
};

export const toOpenAIChatMessages = (messages: readonly ChatMessage[]): readonly Record<string, unknown>[] =>
    messages.map((message) => {
        if (message.role === "tool") {
            const text = typeof message.content === "string"
                ? message.content
                : message.content.map((part) => part.type === "text" ? part.text : "(attached file)").join("");
            return {
                role: "tool",
                tool_call_id: message.toolCallId ?? "",
                content: text,
            };
        }
        if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
            return {
                role: "assistant",
                content: null,
                tool_calls: message.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments),
                    },
                })),
            };
        }
        if (typeof message.content === "string") {
            return { role: message.role, content: message.content };
        }
        return { role: message.role, content: message.content.map(toOpenAIPart) };
    });

const toJsonValue = (value: unknown): ToolCall["arguments"][string] => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
    if (isRecord(value)) return toJsonObject(value);
    return null;
};

const toJsonObject = (record: Readonly<Record<string, unknown>>): ToolCall["arguments"] => {
    const out: ToolCall["arguments"] = {};
    for (const [key, val] of Object.entries(record)) {
        if (val !== undefined) out[key] = toJsonValue(val);
    }
    return out;
};

const toPiContext = (
    messages: readonly ChatMessage[],
    effectiveModel: Pick<ProviderModel, "api" | "provider" | "id">,
    callKind: "emission" | "bare",
    bedrockMediaSlots?: BedrockMediaSlot[],
): TranscriptContext => {
    const toPiPart = (part: ChatContentPart): TextContent | ImageContent => {
        if (part.type === "text") return { type: "text", text: part.text };
        const mediaType = part.mediaType.split(";")[0]?.trim().toLowerCase() ?? part.mediaType;
        if (effectiveModel.api === "bedrock-converse-stream"
            && bedrockMediaSlots !== undefined
            && !BEDROCK_IMAGE_MEDIA_TYPES.has(mediaType)) {
            const slotIndex = bedrockMediaSlots.length;
            bedrockMediaSlots.push({ mediaType, data: part.data });
            return {
                type: "text",
                text: `${BEDROCK_MEDIA_SENTINEL_PREFIX}${slotIndex}${BEDROCK_MEDIA_SENTINEL_SUFFIX}`,
            };
        }
        return {
            type: "image",
            data: Buffer.from(part.data).toString("base64"),
            mimeType: mediaType,
        };
    };
    const systemParts: string[] = [];
    const contextMessages: Context["messages"] = [];
    let leadingSystem = true;
    const zeroUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    for (const message of messages) {
        if (leadingSystem && message.role === "system") {
            systemParts.push(typeof message.content === "string"
                ? message.content
                : message.content.map((part) => part.type === "text" ? part.text : "").join(""));
            continue;
        }
        leadingSystem = false;
        if (message.role === "assistant") {
            const replay = message.replay;
            const api = replay?.api ?? effectiveModel.api;
            const provider = replay?.provider ?? effectiveModel.provider;
            const model = replay?.model ?? effectiveModel.id;
            const thinkingBlocks: ThinkingContent[] = (replay?.thinking ?? []).map((tb) => ({
                type: "thinking",
                thinking: tb.thinking,
                ...(tb.thinkingSignature !== undefined ? { thinkingSignature: tb.thinkingSignature } : {}),
                ...(tb.redacted === true ? { redacted: true } : {}),
            }));
            if (message.toolCalls && message.toolCalls.length > 0) {
                const toolBlocks: ToolCall[] = message.toolCalls.map((tc) => ({
                    type: "toolCall",
                    id: tc.id,
                    name: tc.name,
                    arguments: toJsonObject(tc.arguments),
                    ...(tc.thoughtSignature !== undefined ? { thoughtSignature: tc.thoughtSignature } : {}),
                }));
                const textBlocks: TextContent[] = replay?.textSignature !== undefined
                    ? [{ type: "text", text: "", textSignature: replay.textSignature }]
                    : [];
                contextMessages.push({
                    role: "assistant",
                    content: [...thinkingBlocks, ...textBlocks, ...toolBlocks],
                    api,
                    provider,
                    model,
                    usage: zeroUsage,
                    stopReason: "toolUse",
                    timestamp: 0,
                });
                continue;
            }
            const text = typeof message.content === "string"
                ? message.content
                : message.content.map((part) => part.type === "text" ? part.text : "").join("");
            const textBlocks: TextContent[] = text.length > 0 || replay?.textSignature !== undefined || thinkingBlocks.length === 0
                ? [{
                    type: "text",
                    text,
                    ...(replay?.textSignature !== undefined ? { textSignature: replay.textSignature } : {}),
                }]
                : [];
            contextMessages.push({
                role: "assistant",
                content: [...thinkingBlocks, ...textBlocks],
                api,
                provider,
                model,
                usage: zeroUsage,
                stopReason: "stop",
                timestamp: 0,
            });
            continue;
        }
        if (message.role === "tool") {
            const content: (TextContent | ImageContent)[] = typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content.map(toPiPart);
            contextMessages.push({
                role: "toolResult",
                toolCallId: message.toolCallId ?? "",
                toolName: message.toolName ?? "mcp",
                content,
                isError: message.isError ?? false,
                timestamp: 0,
            });
            continue;
        }
        const content: string | (TextContent | ImageContent)[] = typeof message.content === "string"
            ? message.content
            : message.content.map(toPiPart);
        contextMessages.push({
            role: "user",
            content,
            timestamp: 0,
        });
    }
    return normalizeContext({
        ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
        ...(callKind === "emission" ? { tools: [MCP_WIRE_TOOL] } : {}),
        messages: contextMessages,
    });
};

const hasWireContent = (message: ChatMessage): boolean =>
    typeof message.content === "string"
        ? message.content.trim().length > 0
        : message.content.some((part) => part.type !== "text" || part.text.trim().length > 0);

const hasEffectiveWireMessage = (message: ChatMessage, includeEmptyAssistant = false): boolean =>
    message.role === "tool"
    || (message.role === "assistant" && (includeEmptyAssistant || (message.toolCalls?.length ?? 0) > 0))
    || hasWireContent(message);

interface CoalescedWireGroup {
    readonly role: "assistant" | "user";
    readonly sourceIndices: readonly number[];
}

const groupCoalescedWireSourceRanges = (
    messages: readonly ChatMessage[],
    includeEmptyAssistant = false,
): CoalescedWireGroup[] => {
    const firstNonSystem = firstNonSystemMessageIndex(messages);
    const groups: { role: "assistant" | "user"; sourceIndices: number[] }[] = [];
    for (let i = firstNonSystem; i < messages.length; i += 1) {
        const msg = messages[i];
        if (!hasEffectiveWireMessage(msg, includeEmptyAssistant)) continue;
        if (msg.role === "assistant") {
            groups.push({ role: "assistant", sourceIndices: [i] });
        } else {
            const prev = groups.at(-1);
            if (prev?.role === "user") {
                prev.sourceIndices.push(i);
            } else {
                groups.push({ role: "user", sourceIndices: [i] });
            }
        }
    }
    return groups;
};

const sourceWireBlockCount = (message: ChatMessage): number => {
    if (message.role === "tool") return 1;
    if (typeof message.content === "string") return hasWireContent(message) ? 1 : 0;
    return countWireParts(message.content, message.content.length);
};

const countWireParts = (parts: readonly ChatContentPart[], limit: number): number => {
    let count = 0;
    const end = Math.min(limit, parts.length);
    for (let i = 0; i < end; i += 1) {
        const part = parts[i];
        if (part.type !== "text" || part.text.trim().length > 0) count += 1;
    }
    return count;
};

const normalizeOpenAIAudioFormat = (mediaType: string): string => {
    const subtype = mediaType.slice("audio/".length).split(";")[0]?.trim().toLowerCase() ?? "";
    if (subtype === "mpeg" || subtype === "mpga") return "mp3";
    if (subtype === "x-wav" || subtype === "wave") return "wav";
    return subtype;
};

const normalizeBedrockAudioFormat = (mediaType: string): string => {
    const subtype = mediaType.slice("audio/".length).split(";")[0]?.trim().toLowerCase() ?? "";
    if (subtype === "x-wav" || subtype === "wave") return "wav";
    if (subtype === "x-flac") return "flac";
    if (subtype === "x-m4a" || subtype === "mp4a-latm") return "m4a";
    return subtype;
};

const normalizeBedrockVideoFormat = (mediaType: string): string => {
    const subtype = mediaType.slice("video/".length).split(";")[0]?.trim().toLowerCase() ?? "";
    if (subtype === "quicktime") return "mov";
    if (subtype === "3gpp") return "three_gp";
    if (subtype === "x-matroska") return "mkv";
    if (subtype === "x-ms-wmv") return "wmv";
    if (subtype === "x-flv") return "flv";
    return subtype;
};

const parseBase64DataUrl = (url: string): { readonly mediaType: string; readonly base64: string } | null => {
    const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/u.exec(url);
    return match === null ? null : { mediaType: match[1].trim().toLowerCase(), base64: match[2] };
};

// {§provider-request-authority} Project non-text ChatContentPart files onto OpenAI Chat Completions blocks.
const toOpenAIPart = (part: ChatContentPart): Record<string, unknown> => {
    if (part.type === "text") return { type: "text", text: part.text };
    const mediaType = part.mediaType.split(";")[0]?.trim().toLowerCase() ?? part.mediaType;
    const base64 = Buffer.from(part.data).toString("base64");
    if (mediaType === "application/pdf") {
        return {
            type: "file",
            file: {
                filename: "document.pdf",
                file_data: `data:application/pdf;base64,${base64}`,
            },
        };
    }
    if (mediaType.startsWith("audio/")) {
        return {
            type: "input_audio",
            input_audio: {
                data: base64,
                format: normalizeOpenAIAudioFormat(mediaType),
            },
        };
    }
    return {
        type: "image_url",
        image_url: { url: `data:${mediaType};base64,${base64}` },
    };
};

const normalizeOpenAICompletionsWireMedia = (wireMessages: unknown[]): void => {
    for (let i = 0; i < wireMessages.length; i += 1) {
        const msg = wireMessages[i];
        if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
        let convertedNonImage = false;
        let hasRemainingImage = false;
        for (let j = 0; j < msg.content.length; j += 1) {
            const block = msg.content[j];
            if (!isRecord(block) || block.type !== "image_url" || !isRecord(block.image_url) || typeof block.image_url.url !== "string") {
                continue;
            }
            const parsed = parseBase64DataUrl(block.image_url.url);
            if (parsed === null || parsed.mediaType.startsWith("image/")) {
                hasRemainingImage = true;
                continue;
            }
            const preservedMarkers: Record<string, unknown> = {
                ...(block.cache_control === undefined ? {} : { cache_control: block.cache_control }),
                ...(block.prompt_cache_breakpoint === undefined ? {} : { prompt_cache_breakpoint: block.prompt_cache_breakpoint }),
            };
            if (parsed.mediaType === "application/pdf") {
                msg.content[j] = {
                    type: "file",
                    file: { filename: "document.pdf", file_data: block.image_url.url },
                    ...preservedMarkers,
                };
                convertedNonImage = true;
            } else if (parsed.mediaType.startsWith("audio/")) {
                msg.content[j] = {
                    type: "input_audio",
                    input_audio: { data: parsed.base64, format: normalizeOpenAIAudioFormat(parsed.mediaType) },
                    ...preservedMarkers,
                };
                convertedNonImage = true;
            } else {
                hasRemainingImage = true;
            }
        }
        if (convertedNonImage && !hasRemainingImage) {
            const firstBlock = msg.content[0];
            if (isRecord(firstBlock) && firstBlock.type === "text" && firstBlock.text === "Attached image(s) from tool result:") {
                firstBlock.text = "Attached file(s) from tool result:";
                for (let k = i - 1; k >= 0; k -= 1) {
                    const prev = wireMessages[k];
                    if (!isRecord(prev) || prev.role !== "tool") break;
                    if (prev.content === "(see attached image)") prev.content = "(see attached file)";
                }
            }
        }
    }
};

const normalizeOpenAIResponsesWireMedia = (inputItems: unknown[]): void => {
    const rewriteParts = (parts: unknown[]): { convertedNonImage: boolean; hasRemainingImage: boolean } => {
        let convertedNonImage = false;
        let hasRemainingImage = false;
        for (let j = 0; j < parts.length; j += 1) {
            const block = parts[j];
            if (!isRecord(block) || block.type !== "input_image" || typeof block.image_url !== "string") continue;
            const parsed = parseBase64DataUrl(block.image_url);
            if (parsed === null || parsed.mediaType.startsWith("image/")) {
                hasRemainingImage = true;
                continue;
            }
            if (parsed.mediaType === "application/pdf") {
                parts[j] = {
                    type: "input_file",
                    filename: "document.pdf",
                    file_data: block.image_url,
                };
                convertedNonImage = true;
            } else if (parsed.mediaType.startsWith("audio/")) {
                parts[j] = {
                    type: "input_audio",
                    input_audio: {
                        data: parsed.base64,
                        format: normalizeOpenAIAudioFormat(parsed.mediaType),
                    },
                };
                convertedNonImage = true;
            } else {
                hasRemainingImage = true;
            }
        }
        return { convertedNonImage, hasRemainingImage };
    };
    for (const item of inputItems) {
        if (!isRecord(item)) continue;
        if (Array.isArray(item.content)) {
            rewriteParts(item.content);
        }
        if (Array.isArray(item.output)) {
            const { convertedNonImage, hasRemainingImage } = rewriteParts(item.output);
            if (convertedNonImage && !hasRemainingImage) {
                const first = item.output[0];
                if (isRecord(first) && first.type === "input_text" && first.text === "(see attached image)") {
                    first.text = "(see attached file)";
                }
            }
        }
    }
};

const applyBedrockMediaSlots = (wireMessages: unknown[], slots: readonly BedrockMediaSlot[]): void => {
    if (slots.length === 0) return;
    let docCount = 0;
    const parseSlotIndex = (block: unknown): number | null => {
        if (!isRecord(block) || typeof block.text !== "string") return null;
        if (!block.text.startsWith(BEDROCK_MEDIA_SENTINEL_PREFIX) || !block.text.endsWith(BEDROCK_MEDIA_SENTINEL_SUFFIX)) {
            return null;
        }
        const index = Number(block.text.slice(BEDROCK_MEDIA_SENTINEL_PREFIX.length, -BEDROCK_MEDIA_SENTINEL_SUFFIX.length));
        return Number.isInteger(index) && index >= 0 && index < slots.length ? index : null;
    };
    const toBedrockMediaBlock = (slot: BedrockMediaSlot): Record<string, unknown> => {
        const bytes = new Uint8Array(slot.data);
        if (slot.mediaType === "application/pdf") {
            docCount += 1;
            return {
                document: {
                    format: "pdf",
                    name: `document-${docCount}`,
                    source: { bytes },
                },
            };
        }
        if (slot.mediaType.startsWith("audio/")) {
            return {
                audio: {
                    format: normalizeBedrockAudioFormat(slot.mediaType),
                    source: { bytes },
                },
            };
        }
        if (slot.mediaType.startsWith("video/")) {
            return {
                video: {
                    format: normalizeBedrockVideoFormat(slot.mediaType),
                    source: { bytes },
                },
            };
        }
        return {
            document: {
                format: "txt",
                name: `attachment-${++docCount}`,
                source: { bytes },
            },
        };
    };
    for (const msg of wireMessages) {
        if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
        const nextContent: unknown[] = [];
        for (const block of msg.content) {
            const directSlot = parseSlotIndex(block);
            if (directSlot !== null) {
                nextContent.push(toBedrockMediaBlock(slots[directSlot]));
                continue;
            }
            if (isRecord(block) && isRecord(block.toolResult) && Array.isArray(block.toolResult.content)) {
                const toolContent: unknown[] = [];
                const hoistedAudio: Record<string, unknown>[] = [];
                for (const inner of block.toolResult.content) {
                    const innerSlot = parseSlotIndex(inner);
                    if (innerSlot === null) {
                        toolContent.push(inner);
                        continue;
                    }
                    const mediaBlock = toBedrockMediaBlock(slots[innerSlot]);
                    if ("audio" in mediaBlock) {
                        hoistedAudio.push(mediaBlock);
                    } else {
                        toolContent.push(mediaBlock);
                    }
                }
                if (toolContent.length === 0 && hoistedAudio.length > 0) {
                    toolContent.push({ text: "(see attached audio)" });
                }
                nextContent.push({
                    ...block,
                    toolResult: {
                        ...block.toolResult,
                        content: toolContent,
                    },
                });
                nextContent.push(...hoistedAudio);
                continue;
            }
            nextContent.push(block);
        }
        msg.content = nextContent;
    }
};

export const formatCacheAffinityValue = (affinity: CacheAffinity, sessionId: string): string => {
    if (affinity.name !== "prompt_cache_key") return sessionId;
    const chars = Array.from(sessionId);
    return chars.length <= 64 ? sessionId : chars.slice(0, 64).join("");
};

const firstNonSystemMessageIndex = (messages: readonly ChatMessage[]): number => {
    for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].role !== "system") return i;
    }
    return messages.length;
};

const splitHistoricalUserChars = (
    text: string,
    prefix: UserCachePrefix | undefined,
): readonly [string, string] | null => {
    if (prefix?.kind !== "chars" || prefix.length <= 0 || prefix.length >= text.length) return null;
    const durable = text.slice(0, prefix.length);
    const tail = text.slice(prefix.length);
    return durable.trim().length > 0 && tail.trim().length > 0 ? [durable, tail] : null;
};

const withEphemeralCacheControl = (parts: Record<string, unknown>[], atIndex: number): Record<string, unknown>[] => {
    if (atIndex >= 0 && atIndex < parts.length) {
        parts[atIndex] = { ...parts[atIndex], cache_control: { type: "ephemeral" } };
    }
    return parts;
};

const withExplicitCacheBreakpoint = (parts: Record<string, unknown>[], atIndex: number): Record<string, unknown>[] => {
    if (atIndex >= 0 && atIndex < parts.length) {
        parts[atIndex] = { ...parts[atIndex], prompt_cache_breakpoint: { mode: "explicit" } };
    }
    return parts;
};

const mapOpenAIExplicitCacheMessages = (
    messages: readonly ChatMessage[],
    cacheBreakpoints: CacheBreakpoints | undefined,
    userCachePrefixes?: readonly (UserCachePrefix | undefined)[],
): readonly Record<string, unknown>[] => {
    let lastLeadingSystemIndex = -1;
    const firstNonSystemIndex = firstNonSystemMessageIndex(messages);
    for (let i = 0; i < firstNonSystemIndex; i += 1) {
        if (cacheBreakpoints !== undefined && hasWireContent(messages[i])) {
            lastLeadingSystemIndex = i;
        }
    }
    const unscopedConversation = cacheBreakpoints === "conversation" && userCachePrefixes === undefined;
    return messages.map((message, index) => {
        if (index === lastLeadingSystemIndex) {
            const parts = typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content.map(toOpenAIPart);
            return {
                role: message.role,
                content: withExplicitCacheBreakpoint(parts, parts.length - 1),
            };
        }
        if (cacheBreakpoints === "conversation" && index >= firstNonSystemIndex && message.role === "user") {
            const prefix = userCachePrefixes?.[index];
            if (prefix === undefined) {
                if (unscopedConversation && hasWireContent(message)) {
                    const parts = typeof message.content === "string"
                        ? [{ type: "text", text: message.content }]
                        : message.content.map(toOpenAIPart);
                    return {
                        role: message.role,
                        content: withExplicitCacheBreakpoint(parts, parts.length - 1),
                    };
                }
            } else if (prefix.kind === "chars" && typeof message.content === "string") {
                if (prefix.length <= 0) {
                    return { role: message.role, content: message.content };
                }
                if (prefix.length >= message.content.length) {
                    return message.content.trim().length > 0
                        ? {
                            role: message.role,
                            content: [{
                                type: "text",
                                text: message.content,
                                prompt_cache_breakpoint: { mode: "explicit" },
                            }],
                        }
                        : { role: message.role, content: message.content };
                }
                const durable = message.content.slice(0, prefix.length);
                const tail = message.content.slice(prefix.length);
                if (durable.trim().length === 0) {
                    return { role: message.role, content: message.content };
                }
                return {
                    role: message.role,
                    content: tail.trim().length > 0
                        ? [
                            { type: "text", text: durable, prompt_cache_breakpoint: { mode: "explicit" } },
                            { type: "text", text: tail },
                        ]
                        : [{ type: "text", text: durable, prompt_cache_breakpoint: { mode: "explicit" } }],
                };
            } else if (prefix.kind === "parts" && Array.isArray(message.content)) {
                const parts = message.content.map(toOpenAIPart);
                const targetIndex = Math.min(prefix.count, parts.length) - 1;
                return {
                    role: message.role,
                    content: prefix.count > 0
                        ? withExplicitCacheBreakpoint(parts, targetIndex)
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

const mapOpenAICompatibleMessages = (
    messages: readonly ChatMessage[],
    cacheBreakpoints: CacheBreakpoints | undefined,
    userCachePrefixes?: readonly (UserCachePrefix | undefined)[],
): readonly Record<string, unknown>[] => {
    let lastLeadingSystemIndex = -1;
    const firstNonSystemIndex = firstNonSystemMessageIndex(messages);
    for (let i = 0; i < firstNonSystemIndex; i += 1) {
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
        if (index === lastLeadingSystemIndex) {
            const parts = typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content.map(toOpenAIPart);
            return {
                role: message.role,
                content: withEphemeralCacheControl(parts, parts.length - 1),
            };
        }
        if (index === finalUserIndex) {
            const finalPrefix = userCachePrefixes?.[index];
            if (finalPrefix === undefined) {
                const parts = typeof message.content === "string"
                    ? [{ type: "text", text: message.content }]
                    : message.content.map(toOpenAIPart);
                return {
                    role: message.role,
                    content: withEphemeralCacheControl(parts, parts.length - 1),
                };
            }
            if (finalPrefix.kind === "chars" && typeof message.content === "string") {
                if (finalPrefix.length <= 0) {
                    return { role: message.role, content: message.content };
                }
                if (finalPrefix.length >= message.content.length) {
                    return {
                        role: message.role,
                        content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }],
                    };
                }
                const durable = message.content.slice(0, finalPrefix.length);
                const volatile = message.content.slice(finalPrefix.length);
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
            if (finalPrefix.kind === "parts" && Array.isArray(message.content)) {
                const parts = message.content.map(toOpenAIPart);
                const targetIndex = Math.min(finalPrefix.count, parts.length) - 1;
                return {
                    role: message.role,
                    content: finalPrefix.count > 0
                        ? withEphemeralCacheControl(parts, targetIndex)
                        : parts,
                };
            }
        }
        const historicalSplit = cacheBreakpoints === "conversation"
            && index >= firstNonSystemIndex
            && message.role === "user"
            && typeof message.content === "string"
            ? splitHistoricalUserChars(message.content, userCachePrefixes?.[index])
            : null;
        if (index === penultimateNonSystemIndex) {
            const parts: Record<string, unknown>[] = historicalSplit !== null
                ? [{ type: "text", text: historicalSplit[0] }, { type: "text", text: historicalSplit[1] }]
                : typeof message.content === "string"
                    ? [{ type: "text", text: message.content }]
                    : message.content.map(toOpenAIPart);
            return {
                role: message.role,
                content: withEphemeralCacheControl(parts, parts.length - 1),
            };
        }
        if (historicalSplit !== null) {
            return {
                role: message.role,
                content: [
                    { type: "text", text: historicalSplit[0] },
                    { type: "text", text: historicalSplit[1] },
                ],
            };
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
        for (let i = wireMsg.content.length - 1; i >= 0; i -= 1) {
            const candidate = wireMsg.content[i];
            if (isRecord(candidate) && candidate.type !== "thinking" && candidate.type !== "redacted_thinking") {
                candidate.cache_control = { type: "ephemeral" };
                return;
            }
        }
    }
};

const applyAnthropicPayloadAdjustments = (
    params: Record<string, unknown>,
    messages: readonly ChatMessage[],
    cacheBreakpoints: CacheBreakpoints | undefined,
    userCachePrefixes: readonly (UserCachePrefix | undefined)[] | undefined,
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
    const rewriteAnthropicPdfBlocks = (blocks: unknown[]): { convertedPdf: boolean; hasImage: boolean } => {
        let convertedPdf = false;
        let hasImage = false;
        for (const block of blocks) {
            if (!isRecord(block)) continue;
            if (block.type === "image") {
                if (isRecord(block.source) && block.source.media_type === "application/pdf") {
                    block.type = "document";
                    convertedPdf = true;
                } else {
                    hasImage = true;
                }
            } else if (block.type === "tool_result" && Array.isArray(block.content)) {
                const nested = rewriteAnthropicPdfBlocks(block.content);
                if (nested.convertedPdf && !nested.hasImage) {
                    const first = block.content[0];
                    if (isRecord(first) && first.type === "text" && first.text === "(see attached image)") {
                        first.text = "(see attached file)";
                    }
                }
            }
        }
        return { convertedPdf, hasImage };
    };
    for (const wireMsg of wireMessages) {
        if (!isRecord(wireMsg) || !Array.isArray(wireMsg.content)) continue;
        const { convertedPdf, hasImage } = rewriteAnthropicPdfBlocks(wireMsg.content);
        if (convertedPdf && !hasImage) {
            for (const block of wireMsg.content) {
                if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.includes("tool result image")) {
                    block.text = block.text.replace("image", "file");
                }
            }
        }
    }
    const groups = groupCoalescedWireSourceRanges(messages, false);
    if (cacheBreakpoints !== "conversation" || wireMessages.length === 0) return;
    for (let w = 0; w < Math.min(wireMessages.length - 1, groups.length); w += 1) {
        const group = groups[w];
        const wireMsg = wireMessages[w];
        if (group.role !== "user" || !isRecord(wireMsg)) continue;
        if (typeof wireMsg.content === "string" && group.sourceIndices.length === 1) {
            const srcIdx = group.sourceIndices[0];
            const sourceMsg = messages[srcIdx];
            if (sourceMsg.role === "user" && typeof sourceMsg.content === "string") {
                const split = splitHistoricalUserChars(wireMsg.content, userCachePrefixes?.[srcIdx]);
                if (split !== null) {
                    wireMsg.content = [
                        { type: "text", text: split[0] },
                        { type: "text", text: split[1] },
                    ];
                }
            }
            continue;
        }
        if (Array.isArray(wireMsg.content)) {
            let blockCursor = 0;
            for (const srcIdx of group.sourceIndices) {
                const sourceMsg = messages[srcIdx];
                if (sourceMsg.role === "user" && typeof sourceMsg.content === "string" && blockCursor < wireMsg.content.length) {
                    const wireBlock = wireMsg.content[blockCursor];
                    const text = isRecord(wireBlock) && typeof wireBlock.text === "string"
                        ? wireBlock.text
                        : sourceMsg.content.toWellFormed();
                    const split = splitHistoricalUserChars(text, userCachePrefixes?.[srcIdx]);
                    if (split !== null) {
                        wireMsg.content.splice(
                            blockCursor,
                            1,
                            { type: "text", text: split[0] },
                            { type: "text", text: split[1] },
                        );
                        blockCursor += 2;
                        continue;
                    }
                }
                blockCursor += sourceWireBlockCount(sourceMsg);
            }
        }
    }
    if (wireMessages.length >= 2) {
        markAnthropicMessageEnd(wireMessages[wireMessages.length - 2]);
    }
    const lastWire = wireMessages.at(-1);
    const lastGroup = groups.at(-1);
    const lastSourceIdx = lastGroup?.sourceIndices.at(-1);
    const lastSource = lastSourceIdx === undefined ? undefined : messages[lastSourceIdx];
    if (lastGroup === undefined || lastGroup.role !== "user" || lastSourceIdx === undefined || lastSource === undefined || !isRecord(lastWire) || lastWire.role !== "user") return;
    if (lastSource.role === "tool") {
        markAnthropicMessageEnd(lastWire);
        return;
    }
    const precedingBlockCount = lastGroup.sourceIndices
        .slice(0, -1)
        .reduce((sum, idx) => sum + sourceWireBlockCount(messages[idx]), 0);
    const finalPrefix = userCachePrefixes?.[lastSourceIdx];
    if (finalPrefix === undefined) {
        markAnthropicMessageEnd(lastWire);
        return;
    }
    if (finalPrefix.kind === "chars" && typeof lastSource.content === "string") {
        if (finalPrefix.length <= 0) {
            if (precedingBlockCount > 0 && Array.isArray(lastWire.content) && precedingBlockCount <= lastWire.content.length) {
                const target = lastWire.content[precedingBlockCount - 1];
                if (isRecord(target)) target.cache_control = { type: "ephemeral" };
            }
            return;
        }
        const trailingBlock = Array.isArray(lastWire.content) ? lastWire.content[precedingBlockCount] : undefined;
        const text = typeof lastWire.content === "string"
            ? lastWire.content
            : isRecord(trailingBlock) && typeof trailingBlock.text === "string"
                ? trailingBlock.text
                : lastSource.content.toWellFormed();
        if (finalPrefix.length >= text.length) {
            markAnthropicMessageEnd(lastWire);
            return;
        }
        const durable = text.slice(0, finalPrefix.length);
        const volatile = text.slice(finalPrefix.length);
        if (durable.trim().length === 0) {
            if (precedingBlockCount > 0 && Array.isArray(lastWire.content) && precedingBlockCount <= lastWire.content.length) {
                const target = lastWire.content[precedingBlockCount - 1];
                if (isRecord(target)) target.cache_control = { type: "ephemeral" };
            }
            return;
        }
        const splitBlocks = volatile.trim().length > 0
            ? [
                { type: "text", text: durable, cache_control: { type: "ephemeral" } },
                { type: "text", text: volatile },
            ]
            : [{ type: "text", text: durable, cache_control: { type: "ephemeral" } }];
        if (Array.isArray(lastWire.content) && precedingBlockCount > 0) {
            lastWire.content = [
                ...lastWire.content.slice(0, precedingBlockCount),
                ...splitBlocks,
            ];
        } else {
            lastWire.content = splitBlocks;
        }
        return;
    }
    if (finalPrefix.kind === "parts" && Array.isArray(lastSource.content) && Array.isArray(lastWire.content)) {
        const k = countWireParts(lastSource.content, finalPrefix.count);
        const targetIdx = precedingBlockCount + k - 1;
        if (targetIdx >= 0 && targetIdx < lastWire.content.length) {
            const target = lastWire.content[targetIdx];
            if (isRecord(target)) target.cache_control = { type: "ephemeral" };
        }
    }
};

const appendBedrockCachePoint = (wireMsg: unknown, hasContent = true): void => {
    if (!hasContent) return;
    if (!isRecord(wireMsg) || !Array.isArray(wireMsg.content) || wireMsg.content.length === 0) return;
    if (wireMsg.content.every((block) => isRecord(block) && "reasoningContent" in block)) return;
    wireMsg.content = [...wireMsg.content, { cachePoint: { type: "default" } }];
};

const applyBedrockPayloadAdjustments = (
    params: Record<string, unknown>,
    messages: readonly ChatMessage[],
    cacheBreakpoints: CacheBreakpoints | undefined,
    userCachePrefixes: readonly (UserCachePrefix | undefined)[] | undefined,
): void => {
    if (cacheBreakpoints === undefined) return;
    if (Array.isArray(params.system) && params.system.length > 0) {
        params.system = [...params.system, { cachePoint: { type: "default" } }];
    }
    if (cacheBreakpoints !== "conversation") return;
    const wireMessages = Array.isArray(params.messages) ? params.messages : undefined;
    if (wireMessages === undefined || wireMessages.length === 0) return;
    const groups = groupCoalescedWireSourceRanges(messages, true);
    for (let w = 0; w < Math.min(wireMessages.length - 1, groups.length); w += 1) {
        const group = groups[w];
        const wireMsg = wireMessages[w];
        if (group.role !== "user" || !isRecord(wireMsg) || !Array.isArray(wireMsg.content)) continue;
        let blockCursor = 0;
        for (const srcIdx of group.sourceIndices) {
            const sourceMsg = messages[srcIdx];
            if (sourceMsg.role === "user" && typeof sourceMsg.content === "string" && blockCursor < wireMsg.content.length) {
                const wireBlock = wireMsg.content[blockCursor];
                const text = isRecord(wireBlock) && typeof wireBlock.text === "string"
                    ? wireBlock.text
                    : sourceMsg.content.toWellFormed();
                const split = splitHistoricalUserChars(text, userCachePrefixes?.[srcIdx]);
                if (split !== null) {
                    wireMsg.content.splice(blockCursor, 1, { text: split[0] }, { text: split[1] });
                    blockCursor += 2;
                    continue;
                }
            }
            blockCursor += sourceWireBlockCount(sourceMsg);
        }
    }
    if (wireMessages.length >= 2) {
        const penultGroup = groups[wireMessages.length - 2];
        const penultHasContent = penultGroup !== undefined
            && penultGroup.sourceIndices.some((idx) => hasEffectiveWireMessage(messages[idx], false));
        appendBedrockCachePoint(wireMessages[wireMessages.length - 2], penultHasContent);
    }
    const lastWire = wireMessages.at(-1);
    const lastGroup = groups.at(-1);
    const lastSourceIdx = lastGroup?.sourceIndices.at(-1);
    const lastSource = lastSourceIdx === undefined ? undefined : messages[lastSourceIdx];
    if (lastGroup === undefined || lastGroup.role !== "user" || lastSourceIdx === undefined || lastSource === undefined || !isRecord(lastWire) || lastWire.role !== "user" || !Array.isArray(lastWire.content)) {
        return;
    }
    if (lastSource.role === "tool") {
        appendBedrockCachePoint(lastWire, true);
        return;
    }
    if (!hasWireContent(lastSource)) return;
    const precedingBlockCount = lastGroup.sourceIndices
        .slice(0, -1)
        .reduce((sum, idx) => sum + sourceWireBlockCount(messages[idx]), 0);
    const finalPrefix = userCachePrefixes?.[lastSourceIdx];
    if (finalPrefix === undefined) {
        appendBedrockCachePoint(lastWire, true);
        return;
    }
    if (finalPrefix.kind === "chars" && typeof lastSource.content === "string") {
        if (finalPrefix.length <= 0) {
            if (precedingBlockCount > 0 && precedingBlockCount <= lastWire.content.length) {
                lastWire.content = [
                    ...lastWire.content.slice(0, precedingBlockCount),
                    { cachePoint: { type: "default" } },
                    ...lastWire.content.slice(precedingBlockCount),
                ];
            }
            return;
        }
        const trailingBlock = lastWire.content[precedingBlockCount];
        const text = isRecord(trailingBlock) && typeof trailingBlock.text === "string"
            ? trailingBlock.text
            : lastSource.content.toWellFormed();
        if (finalPrefix.length >= text.length) {
            appendBedrockCachePoint(lastWire, true);
            return;
        }
        const durable = text.slice(0, finalPrefix.length);
        const volatile = text.slice(finalPrefix.length);
        if (durable.trim().length === 0) {
            if (precedingBlockCount > 0 && precedingBlockCount <= lastWire.content.length) {
                lastWire.content = [
                    ...lastWire.content.slice(0, precedingBlockCount),
                    { cachePoint: { type: "default" } },
                    ...lastWire.content.slice(precedingBlockCount),
                ];
            }
            return;
        }
        const splitBlocks = volatile.trim().length > 0
            ? [{ text: durable }, { cachePoint: { type: "default" } }, { text: volatile }]
            : [{ text: durable }, { cachePoint: { type: "default" } }];
        lastWire.content = [
            ...lastWire.content.slice(0, precedingBlockCount),
            ...splitBlocks,
        ];
        return;
    }
    if (finalPrefix.kind === "parts" && Array.isArray(lastSource.content)) {
        const k = countWireParts(lastSource.content, finalPrefix.count);
        const splitAt = precedingBlockCount + k;
        if (splitAt > 0 && splitAt <= lastWire.content.length) {
            lastWire.content = [
                ...lastWire.content.slice(0, splitAt),
                { cachePoint: { type: "default" } },
                ...lastWire.content.slice(splitAt),
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
        readonly toolCalls: ProviderToolCall[];
        readonly replay?: AssistantMessageReplay;
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
        const effectiveInput = providerModel === undefined && url !== undefined
            ? url
            : input;
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

    const mergeConsecutiveUserMessages = (
        wireMessages: unknown[],
        toTextBlock: (text: string) => Record<string, unknown>,
    ): void => {
        for (let i = 1; i < wireMessages.length; i += 1) {
            const prev = wireMessages[i - 1];
            const curr = wireMessages[i];
            if (!isRecord(prev) || !isRecord(curr) || prev.role !== "user" || curr.role !== "user") continue;
            const prevBlocks = Array.isArray(prev.content)
                ? [...prev.content]
                : typeof prev.content === "string"
                    ? [toTextBlock(prev.content)]
                    : [];
            const currBlocks = Array.isArray(curr.content)
                ? curr.content
                : typeof curr.content === "string"
                    ? [toTextBlock(curr.content)]
                    : [];
            prev.content = [...prevBlocks, ...currBlocks];
            wireMessages.splice(i, 1);
            i -= 1;
        }
    };

    const applyInPlaceOpenAICacheMarkers = (
        wireMessages: unknown[],
        markerField: "cache_control" | "prompt_cache_breakpoint",
        markerValue: Record<string, unknown>,
    ): void => {
        const markMsg = (msg: unknown): void => {
            if (!isRecord(msg)) return;
            if (typeof msg.content === "string" && msg.content.trim().length > 0) {
                msg.content = [{ type: "text", text: msg.content, [markerField]: markerValue }];
            } else if (Array.isArray(msg.content) && msg.content.length > 0) {
                const last = msg.content.at(-1);
                if (isRecord(last)) last[markerField] = markerValue;
            }
        };
        if (cacheBreakpoints !== undefined) {
            const first = wireMessages[0];
            if (isRecord(first) && (first.role === "system" || first.role === "developer")) {
                markMsg(first);
            }
        }
        if (cacheBreakpoints !== "conversation") return;
        const firstNonSystem = firstNonSystemMessageIndex(messages);
        const sourceIndices: number[] = [];
        for (let i = firstNonSystem; i < messages.length; i += 1) {
            if (hasEffectiveWireMessage(messages[i], true)) sourceIndices.push(i);
        }
        const nonSystem = wireMessages.filter((m) => isRecord(m) && m.role !== "system" && m.role !== "developer");
        for (let w = 0; w < Math.min(nonSystem.length - 1, sourceIndices.length); w += 1) {
            const srcIdx = sourceIndices[w];
            const sourceMsg = messages[srcIdx];
            const wireMsg = nonSystem[w];
            if (sourceMsg.role === "user" && typeof sourceMsg.content === "string" && isRecord(wireMsg) && typeof wireMsg.content === "string") {
                const split = splitHistoricalUserChars(wireMsg.content, userCachePrefixes?.[srcIdx]);
                if (split !== null) {
                    wireMsg.content = [
                        { type: "text", text: split[0] },
                        { type: "text", text: split[1] },
                    ];
                }
            }
        }
        if (nonSystem.length >= 2) markMsg(nonSystem[nonSystem.length - 2]);
        const last = nonSystem.at(-1);
        const lastSourceIdx = sourceIndices.at(-1);
        const lastSource = lastSourceIdx === undefined ? undefined : messages[lastSourceIdx];
        if (!isRecord(last) || last.role !== "user" || lastSourceIdx === undefined || lastSource === undefined || lastSource.role !== "user") return;
        const finalPrefix = userCachePrefixes?.[lastSourceIdx];
        if (finalPrefix === undefined) {
            markMsg(last);
            return;
        }
        if (finalPrefix.kind === "chars" && typeof lastSource.content === "string") {
            if (finalPrefix.length <= 0) return;
            const text = typeof last.content === "string" ? last.content : lastSource.content.toWellFormed();
            if (finalPrefix.length >= text.length) {
                markMsg(last);
                return;
            }
            const durable = text.slice(0, finalPrefix.length);
            const volatile = text.slice(finalPrefix.length);
            if (durable.trim().length === 0) return;
            last.content = volatile.trim().length > 0
                ? [
                    { type: "text", text: durable, [markerField]: markerValue },
                    { type: "text", text: volatile },
                ]
                : [{ type: "text", text: durable, [markerField]: markerValue }];
            return;
        }
        if (finalPrefix.kind === "parts" && Array.isArray(lastSource.content) && Array.isArray(last.content)) {
            const k = countWireParts(lastSource.content, finalPrefix.count);
            if (k > 0 && k <= last.content.length && isRecord(last.content[k - 1])) {
                last.content[k - 1][markerField] = markerValue;
            }
        }
    };

    const onPayload = async (payload: unknown) => {
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
                    applyInPlaceOpenAICacheMarkers(params.messages, "prompt_cache_breakpoint", { mode: "explicit" });
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
                    applyInPlaceOpenAICacheMarkers(params.messages, "cache_control", { type: "ephemeral" });
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
                    ? params.include.filter((item): item is string => typeof item !== "undefined" && typeof item === "string")
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
                const contents: unknown[] = params.contents;
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
                for (const entry of params.contents) {
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
                            ? {
                                enabled: true,
                                level: googleLevel,
                            }
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

    const forensics = collectChunkForensics(rawChunks);
    const messageInfo = extractFromAssistantMessage(finalMessage ?? lastErrorMessage);
    let diagnosticStatus: number | undefined;
    let diagnosticRequestId: string | undefined;
    for (const diag of lastErrorMessage?.diagnostics ?? []) {
        if (!isRecord(diag) || diag.type !== "bedrock_response_failure" || !isRecord(diag.details)) continue;
        if (typeof diag.details.status === "number") {
            diagnosticStatus = diag.details.status;
        } else if (typeof diag.details.errorCode === "string") {
            diagnosticStatus = BEDROCK_ERROR_CODE_STATUS[diag.details.errorCode];
        }
        if (typeof diag.details.requestId === "string" && diag.details.requestId.length > 0) {
            diagnosticRequestId = diag.details.requestId;
        }
    }
    const responseHeaders = diagnosticRequestId !== undefined && httpResponse?.headers["x-amzn-requestid"] === undefined
        ? { ...httpResponse?.headers, "x-amzn-requestid": diagnosticRequestId }
        : httpResponse?.headers;
    const responseId = finalMessage?.responseId ?? lastErrorMessage?.responseId ?? forensics.id ?? diagnosticRequestId;

    if (finalMessage === undefined) {
        let statusCode = httpResponse !== undefined && !httpResponse.ok
            ? httpResponse.status
            : diagnosticStatus;
        if (httpErrorBody === undefined && streamError !== undefined) {
            const googleStreamMatch = /^got status: [A-Z_]+\. (\{[\s\S]+\})$/u.exec(streamError);
            if (googleStreamMatch !== null) {
                httpErrorBody = googleStreamMatch[1];
                if (statusCode === undefined) {
                    try {
                        const parsed: unknown = JSON.parse(httpErrorBody);
                        const code = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.code : undefined;
                        if (typeof code === "number" && code >= 400 && code < 600) statusCode = code;
                    } catch {
                        // ignore non-JSON chunk
                    }
                }
            } else {
                const statusBodyMatch = /^(?:[A-Za-z][A-Za-z0-9 _-]*: )?(\d{3}): (\{[\s\S]+\}|<[\s\S]+>|[^\n]+)$/u.exec(streamError);
                if (statusBodyMatch !== null) {
                    const parsedCode = Number(statusBodyMatch[1]);
                    if (statusCode === undefined && parsedCode >= 400 && parsedCode < 600) {
                        statusCode = parsedCode;
                    }
                    if (statusBodyMatch[2].startsWith("{") || statusBodyMatch[2].startsWith("<")) {
                        httpErrorBody = statusBodyMatch[2];
                    }
                }
            }
        }
        const failureRawBody = rawChunks.length > 0
            ? rawChunks
            : httpErrorBody !== undefined && httpErrorBody.length > 0
                ? httpErrorBody
                : undefined;
        if (operationSignal?.aborted) {
            const abortError = abortFailure(operationSignal);
            const usage = toUsageFromPiMessage(lastErrorMessage, forensics.rawUsage);
            attachFailureEvidence(abortError, {
                status: httpResponse?.status ?? diagnosticStatus,
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
        const apiError = new ProviderHttpError({
            message: errorMessage,
            url: requestUrl,
            statusCode,
            responseHeaders,
            responseBody: httpErrorBody,
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
            replay: {
                api: effectiveModel.api,
                provider: effectiveModel.provider,
                model: effectiveModel.id,
                ...(messageInfo.thinking.length > 0 ? { thinking: messageInfo.thinking } : {}),
                ...(messageInfo.textSignature === undefined ? {} : { textSignature: messageInfo.textSignature }),
            },
            unmappedChunks: [],
        },
        ...(rawBody ? { rawBody: rawChunks } : {}),
    };
};
