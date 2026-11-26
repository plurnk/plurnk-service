// {§provider-sdk-boundary} {§provider-request-authority} Transcript context normalization and wire source grouping.

import type {
    Context,
    ImageContent,
    TextContent,
    ThinkingContent,
    ToolCall,
    TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { MCP_WIRE_TOOL, isRecord } from "@plurnk/plurnk-contracts";
import type { ChatContentPart, ChatMessage, ProviderModel } from "../types.ts";
import {
    BEDROCK_IMAGE_MEDIA_TYPES,
    BEDROCK_MEDIA_SENTINEL_PREFIX,
    BEDROCK_MEDIA_SENTINEL_SUFFIX,
    type BedrockMediaSlot,
} from "./media.ts";

const PI_BUILTIN_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
    "alibaba": "qwen-token-plan",
    "alibaba-cn": "qwen-token-plan-cn",
    "fireworks-ai": "fireworks",
    "togetherai": "together",
    "zai-coding-plan": "zai",
};

const BUILTIN_PROVIDER_SLUG = /^[a-z0-9-]+$/u;
const builtinModelsCache = new Map<string, Promise<Readonly<Record<string, unknown>> | null>>();

const loadPiBuiltinModels = (providerSlug: string): Promise<Readonly<Record<string, unknown>> | null> => {
    if (!BUILTIN_PROVIDER_SLUG.test(providerSlug)) return Promise.resolve(null);
    let cached = builtinModelsCache.get(providerSlug);
    if (cached === undefined) {
        const specifier = `@earendil-works/pi-ai/providers/${providerSlug}.models`;
        cached = import(specifier).then((mod: unknown) => {
            if (!isRecord(mod)) return null;
            for (const [exportName, value] of Object.entries(mod)) {
                if (
                    exportName.endsWith("_MODELS")
                    && !exportName.endsWith("_IMAGE_MODELS")
                    && !exportName.endsWith("_CLASSIFIER_MODELS")
                    && isRecord(value)
                ) {
                    return value;
                }
            }
            return null;
        }).catch(() => null);
        builtinModelsCache.set(providerSlug, cached);
    }
    return cached;
};

export const lookupPiBuiltinCompat = async (
    providerId: string,
    modelId: string,
): Promise<Pick<NonNullable<ProviderModel["compat"]>, "requiresReasoningContentOnAssistantMessages" | "zaiToolStream">> => {
    const targetProvider = PI_BUILTIN_PROVIDER_ALIASES[providerId] ?? providerId;
    const models = await loadPiBuiltinModels(targetProvider);
    if (models === null) return {};
    const direct = models[modelId];
    const builtin = isRecord(direct) && direct.id === modelId
        ? direct
        : Object.values(models).find((candidate) => isRecord(candidate) && candidate.id === modelId);
    const rawCompat: unknown = isRecord(builtin) ? builtin.compat : undefined;
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

export const toPiContext = (
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

export const firstNonSystemMessageIndex = (messages: readonly ChatMessage[]): number => {
    for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].role !== "system") return i;
    }
    return messages.length;
};

export const hasWireContent = (message: ChatMessage): boolean =>
    typeof message.content === "string"
        ? message.content.trim().length > 0
        : message.content.some((part) => part.type !== "text" || part.text.trim().length > 0);

export const hasEffectiveWireMessage = (message: ChatMessage, includeEmptyAssistant = false): boolean =>
    message.role === "tool"
    || (message.role === "assistant" && (includeEmptyAssistant || (message.toolCalls?.length ?? 0) > 0))
    || hasWireContent(message);

export interface CoalescedWireGroup {
    readonly role: "assistant" | "user";
    readonly sourceIndices: readonly number[];
}

export const groupCoalescedWireSourceRanges = (
    messages: readonly ChatMessage[],
    includeEmptyAssistant = false,
): CoalescedWireGroup[] => {
    const firstNonSystem = firstNonSystemMessageIndex(messages);
    const groups: Array<{ role: "assistant" | "user"; sourceIndices: number[] }> = [];
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

export const countWireParts = (parts: readonly ChatContentPart[], limit: number): number => {
    let count = 0;
    const end = Math.min(limit, parts.length);
    for (let i = 0; i < end; i += 1) {
        const part = parts[i];
        if (part.type !== "text" || part.text.trim().length > 0) count += 1;
    }
    return count;
};

export const sourceWireBlockCount = (message: ChatMessage): number => {
    if (message.role === "tool") return 1;
    if (typeof message.content === "string") return hasWireContent(message) ? 1 : 0;
    return countWireParts(message.content, message.content.length);
};
