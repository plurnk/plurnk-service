// {§provider-request-authority} Prompt-cache breakpoint placement for OpenAI, Anthropic, and Bedrock wire payloads.

import { isRecord } from "@plurnk/plurnk-contracts";
import type { CacheAffinity, CacheBreakpoints } from "../ModelProvider.ts";
import type { ChatMessage, UserCachePrefix } from "../types.ts";
import {
    countWireParts,
    firstNonSystemMessageIndex,
    groupCoalescedWireSourceRanges,
    hasEffectiveWireMessage,
    hasWireContent,
    sourceWireBlockCount,
} from "./context.ts";
import { toOpenAIPart } from "./media.ts";

export const formatCacheAffinityValue = (affinity: CacheAffinity, sessionId: string): string => {
    if (affinity.name !== "prompt_cache_key") return sessionId;
    const chars = Array.from(sessionId);
    return chars.length <= 64 ? sessionId : chars.slice(0, 64).join("");
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

export const mapOpenAIExplicitCacheMessages = (
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

export const mapOpenAICompatibleMessages = (
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

export const applyInPlaceOpenAICacheMarkers = (args: {
    readonly wireMessages: unknown[];
    readonly messages: readonly ChatMessage[];
    readonly cacheBreakpoints: CacheBreakpoints | undefined;
    readonly userCachePrefixes?: readonly (UserCachePrefix | undefined)[];
    readonly markerField: "cache_control" | "prompt_cache_breakpoint";
    readonly markerValue: Record<string, unknown>;
}): void => {
    const { wireMessages, messages, cacheBreakpoints, userCachePrefixes, markerField, markerValue } = args;
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

export const mergeConsecutiveUserMessages = (
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

export const applyAnthropicPayloadAdjustments = (
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

export const applyBedrockPayloadAdjustments = (
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
