// {§provider-request-authority} Multimodal media normalization across OpenAI, Anthropic, Google, and Bedrock payloads.

import { isRecord } from "@plurnk/plurnk-contracts";
import type { ChatContentPart, ChatMessage } from "../types.ts";

export const BEDROCK_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
]);

export const BEDROCK_MEDIA_SENTINEL_PREFIX = "\0plurnk-bedrock-media:";
export const BEDROCK_MEDIA_SENTINEL_SUFFIX = "\0";

export interface BedrockMediaSlot {
    readonly mediaType: string;
    readonly data: Uint8Array;
}

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

export const toOpenAIPart = (part: ChatContentPart): Record<string, unknown> => {
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

export const normalizeOpenAICompletionsWireMedia = (wireMessages: unknown[]): void => {
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

export const normalizeOpenAIResponsesWireMedia = (inputItems: unknown[]): void => {
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

export const applyBedrockMediaSlots = (wireMessages: unknown[], slots: readonly BedrockMediaSlot[]): void => {
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
