// {§provider-failure-normalization} {§provider-sdk-boundary} Assistant message extraction, stop-reason normalization,
// chunk forensics, usage reconciliation, and failure evidence attachment (#1305, #1313).

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRecord } from "@plurnk/plurnk-contracts";
import { APICallError, RetryError } from "./errors.ts";
import type {
    ProviderAttemptFinishReason,
    ProviderChargeEvidence,
    ProviderUsage,
    TokenLogprob,
} from "./types.ts";
import { UsageDetailError, normalizeUsage } from "./usage.ts";

const ProviderFailureTransportSymbol = Symbol("plurnk.provider.failureTransport");

export interface FailureEvidence {
    readonly status?: number;
    readonly usage?: ProviderUsage;
    readonly chargeEvidence: ProviderChargeEvidence;
    readonly content: string;
    readonly reasoning: string;
    readonly error: { readonly name: string; readonly message: string };
    readonly rawBody?: unknown;
    readonly outputObserved?: boolean;
}

export const serializeError = (error: unknown): { readonly name: string; readonly message: string } =>
    error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "Error", message: String(error) };

// {§provider-failure-normalization} (#971) — evidence is keyed by the failure object, so the object
// must be this request's own. A caller's abort reason is shared by every request on that signal (or
// may not be an object), so it is wrapped per request before anything is keyed on it.
export const abortFailure = (signal: AbortSignal): Error => {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) {
        const copy = new Error(reason.message, { cause: reason });
        copy.name = reason.name;
        return copy;
    }
    return new DOMException(
        typeof reason === "string" && reason.length > 0 ? reason : "The operation was aborted.",
        "AbortError",
    );
};

export const attachFailureEvidence = (error: unknown, evidence: FailureEvidence): void => {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
        Object.defineProperty(error, ProviderFailureTransportSymbol, {
            value: evidence,
            enumerable: false,
            configurable: true,
        });
    }
};

export const readFailureEvidence = (error: unknown): FailureEvidence => {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
        const attached = (error as { [ProviderFailureTransportSymbol]?: FailureEvidence })[ProviderFailureTransportSymbol];
        if (attached !== undefined) return attached;
    }
    if (APICallError.isInstance(error)) {
        return {
            status: error.statusCode,
            chargeEvidence: { response: { headers: error.responseHeaders } },
            content: "",
            reasoning: "",
            error: serializeError(error),
            ...(error.responseBody !== undefined ? { rawBody: error.responseBody } : {}),
        };
    }
    if (RetryError.isInstance(error) && error.errors.length > 0) {
        return readFailureEvidence(error.errors.at(-1));
    }
    return {
        chargeEvidence: { response: {} },
        content: "",
        reasoning: "",
        error: serializeError(error),
    };
};

const RESOURCE_INTERRUPTED_FINISH_REASONS: ReadonlySet<string> = new Set([
    "preempted",
    "insufficient_system_resource",
    "model_overloaded",
    "server_overloaded",
]);

export const RETRYABLE_MALFORMED_FINISH_REASONS: ReadonlySet<string> = new Set([
    "MALFORMED_RESPONSE",
    "MALFORMED_FUNCTION_CALL",
    "UNEXPECTED_TOOL_CALL",
]);

const LEADING_THINK_ENVELOPE = /^(?:\s*<think>[\s\S]*?<\/think>\s*)+/;
const SINGLE_LINE_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^`~\s].*?)[ \t]*\1[ \t]*$/;
const OPEN_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^`~\s].*)$/;
const CLOSE_FENCE = /^[ \t]*(`{3,}|~{3,})[^\w\s`~]?[ \t]*$/;

// {§provider-failure-normalization} A response whose visible content consists entirely of one or more
// balanced, closed operation fences (with no unclosed fence and no trailing unfenced text) has already
// delivered its complete operational emission before any trailing vendor finish reason.
const hasCompleteFencedContent = (rawContent: string): boolean => {
    const content = rawContent.replace(LEADING_THINK_ENVELOPE, "");
    if (content.trim().length === 0) return false;
    const lines = content.split(/\r?\n/);
    let openFence: { readonly char: string; readonly length: number } | null = null;
    let closedBlocks = 0;
    for (const line of lines) {
        if (openFence === null) {
            if (line.trim().length === 0) continue;
            const single = SINGLE_LINE_FENCE.exec(line);
            if (single !== null && !single[2].includes(single[1][0])) {
                closedBlocks += 1;
                continue;
            }
            const opened = OPEN_FENCE.exec(line);
            if (opened !== null) {
                openFence = { char: opened[1][0], length: opened[1].length };
                continue;
            }
            return false;
        }
        const closed = CLOSE_FENCE.exec(line);
        if (closed !== null && closed[1][0] === openFence.char && closed[1].length >= openFence.length) {
            openFence = null;
            closedBlocks += 1;
        }
    }
    return openFence === null && closedBlocks > 0;
};

const normalizeStopReason = (
    stopReason: AssistantMessage["stopReason"] | undefined,
    rawStopReason: string | undefined,
): { finishReason: ProviderAttemptFinishReason; rawFinishReason?: string } => {
    const raw = typeof rawStopReason === "string" && rawStopReason.length > 0 ? rawStopReason : undefined;
    if (raw !== undefined) {
        if (RESOURCE_INTERRUPTED_FINISH_REASONS.has(raw)) {
            return { finishReason: "resource_interrupted", rawFinishReason: raw };
        }
        switch (raw) {
            case "stop":
            case "end_turn":
            case "stop_sequence":
            case "STOP":
            case "completed":
            case "complete":
                return { finishReason: "stop", rawFinishReason: raw };
            case "length":
            case "max_tokens":
            case "MAX_TOKENS":
            case "incomplete":
            case "max_output_tokens":
                return { finishReason: "length", rawFinishReason: raw };
            case "tool_calls":
            case "tool_use":
            case "function_call":
                return { finishReason: "tool_calls", rawFinishReason: raw };
            case "content_filter":
            case "refusal":
            case "safety":
            case "recitation":
            case "SAFETY":
            case "RECITATION":
            case "BLOCKLIST":
            case "PROHIBITED_CONTENT":
            case "SPII":
            case "IMAGE_SAFETY":
            case "content_filtered":
            case "guardrail_intervened":
                return { finishReason: "content_filter", rawFinishReason: raw };
            default:
                return { finishReason: "error", rawFinishReason: raw };
        }
    }
    switch (stopReason) {
        case "stop":
            return { finishReason: "stop" };
        case "length":
            return { finishReason: "length" };
        case "toolUse":
            return { finishReason: "tool_calls" };
        case "error":
        case "aborted":
            return { finishReason: "error" };
        default:
            return { finishReason: null };
    }
};

export interface ExtractedAssistantMessage {
    readonly content: string;
    readonly reasoning: string;
    readonly reasoningProjected: boolean;
    readonly toolCalls: { index: number; id: string; type: string; name: string; arguments: string }[];
    readonly finishReason: ProviderAttemptFinishReason;
    readonly rawFinishReason: string | undefined;
}

export const extractFromAssistantMessage = (message: AssistantMessage | undefined): ExtractedAssistantMessage => {
    if (message === undefined) {
        return {
            content: "",
            reasoning: "",
            reasoningProjected: false,
            toolCalls: [] as { index: number; id: string; type: string; name: string; arguments: string }[],
            finishReason: null as ProviderAttemptFinishReason,
            rawFinishReason: undefined as string | undefined,
        };
    }
    let content = "";
    let reasoning = "";
    const toolCalls: { index: number; id: string; type: string; name: string; arguments: string }[] = [];
    for (const block of message.content) {
        if (block.type === "text") {
            content += block.text;
        } else if (block.type === "thinking") {
            if (block.thinking.length > 0) {
                reasoning += block.thinking;
            } else if (typeof block.thinkingSignature === "string" && block.thinkingSignature.startsWith("[")) {
                try {
                    const details: unknown = JSON.parse(block.thinkingSignature);
                    if (Array.isArray(details)) {
                        for (const detail of details) {
                            if (!isRecord(detail)) continue;
                            if (typeof detail.text === "string") reasoning += detail.text;
                            else if (typeof detail.summary === "string") reasoning += detail.summary;
                        }
                    }
                } catch {
                    // signature is opaque
                }
            }
        } else if (block.type === "toolCall") {
            toolCalls.push({
                index: toolCalls.length,
                id: block.id,
                type: "function",
                name: block.name,
                arguments: JSON.stringify(block.arguments),
            });
        }
    }
    const normalized = normalizeStopReason(message.stopReason, message.rawStopReason);
    const finishReason = (normalized.finishReason === "error" || normalized.finishReason === "length")
        && toolCalls.length === 0
        && hasCompleteFencedContent(content)
        ? "stop"
        : normalized.finishReason;
    const rawFinishReason = normalized.rawFinishReason
        ?? (finishReason !== normalized.finishReason && normalized.finishReason !== null
            ? normalized.finishReason
            : undefined);
    return {
        content,
        reasoning,
        reasoningProjected: reasoning.length > 0,
        toolCalls,
        finishReason,
        rawFinishReason,
    };
};

const STANDARD_CHUNK_KEYS: ReadonlySet<string> = new Set([
    "id",
    "object",
    "created",
    "model",
    "choices",
    "usage",
    "charge",
    "system_fingerprint",
    "service_tier",
    "type",
    "index",
    "delta",
    "message",
    "content_block",
    "candidates",
    "usageMetadata",
    "modelVersion",
    "responseId",
    "contentBlockStart",
    "contentBlockDelta",
    "contentBlockStop",
    "messageStart",
    "messageStop",
    "metadata",
    "amazon-bedrock-invocationMetrics",
]);

const STANDARD_DELTA_KEYS: ReadonlySet<string> = new Set([
    "role",
    "content",
    "reasoning_content",
    "reasoning",
    "reasoning_text",
    "reasoning_details",
    "tool_calls",
    "function_call",
    "audio",
]);

const extractLogprobs = (choice: Record<string, unknown>): TokenLogprob[] => {
    if (!isRecord(choice.logprobs) || !Array.isArray(choice.logprobs.content)) return [];
    const out: TokenLogprob[] = [];
    for (const item of choice.logprobs.content) {
        if (!isRecord(item) || typeof item.token !== "string" || typeof item.logprob !== "number") continue;
        const top = Array.isArray(item.top_logprobs)
            ? item.top_logprobs.flatMap((alt) =>
                isRecord(alt) && typeof alt.token === "string" && typeof alt.logprob === "number"
                    ? [{ token: alt.token, logprob: alt.logprob }]
                    : [])
            : undefined;
        out.push({
            token: item.token,
            logprob: item.logprob,
            ...(top !== undefined && top.length > 0 ? { top } : {}),
        });
    }
    return out;
};

export interface ChunkForensics {
    readonly id: string | undefined;
    readonly model: string | undefined;
    readonly rawUsage: Record<string, unknown> | undefined;
    readonly charge: unknown;
    readonly rawFinishReason: string | undefined;
    readonly logprobs: TokenLogprob[];
    readonly metadata: Record<string, unknown>;
    readonly channels: Record<string, string>;
}

export const collectChunkForensics = (rawChunks: readonly unknown[]): ChunkForensics => {
    let id: string | undefined;
    let model: string | undefined;
    let rawUsage: Record<string, unknown> | undefined;
    let charge: unknown;
    let rawFinishReason: string | undefined;
    const logprobs: TokenLogprob[] = [];
    const metadata: Record<string, unknown> = {};
    const channels: Record<string, string> = {};
    for (const chunk of rawChunks) {
        if (!isRecord(chunk)) continue;
        if (typeof chunk.id === "string" && chunk.id.length > 0) id = chunk.id;
        else if (typeof chunk.responseId === "string" && chunk.responseId.length > 0) id = chunk.responseId;
        else if (isRecord(chunk.message) && typeof chunk.message.id === "string") id = chunk.message.id;
        if (typeof chunk.model === "string" && chunk.model.length > 0) model = chunk.model;
        else if (typeof chunk.modelVersion === "string" && chunk.modelVersion.length > 0) model = chunk.modelVersion;
        else if (isRecord(chunk.message) && typeof chunk.message.model === "string") model = chunk.message.model;
        for (const [key, value] of Object.entries(chunk)) {
            if (!STANDARD_CHUNK_KEYS.has(key) && value !== undefined) {
                metadata[key] = value;
            }
        }
        if (chunk.charge !== undefined) {
            charge = chunk.charge;
        }
        if (isRecord(chunk.usage)) {
            rawUsage = Object.assign(rawUsage ?? {}, chunk.usage);
        }
        if (isRecord(chunk.message) && isRecord(chunk.message.usage)) {
            rawUsage = Object.assign(rawUsage ?? {}, chunk.message.usage);
        }
        if (isRecord(chunk.delta) && typeof chunk.delta.stop_reason === "string" && chunk.delta.stop_reason.length > 0) {
            rawFinishReason = chunk.delta.stop_reason;
        }
        if (typeof chunk.stopReason === "string" && chunk.stopReason.length > 0) {
            rawFinishReason = chunk.stopReason;
        }
        if (Array.isArray(chunk.candidates)) {
            for (const candidate of chunk.candidates) {
                if (isRecord(candidate) && typeof candidate.finishReason === "string" && candidate.finishReason.length > 0) {
                    rawFinishReason = candidate.finishReason;
                }
            }
        }
        if (Array.isArray(chunk.choices)) {
            for (const choice of chunk.choices) {
                if (!isRecord(choice)) continue;
                logprobs.push(...extractLogprobs(choice));
                if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
                    rawFinishReason = choice.finish_reason;
                }
                if (isRecord(choice.delta)) {
                    for (const [key, value] of Object.entries(choice.delta)) {
                        if (!STANDARD_DELTA_KEYS.has(key) && typeof value === "string" && value.length > 0) {
                            channels[key] = (channels[key] ?? "") + value;
                        }
                    }
                }
            }
        }
    }
    return { id, model, rawUsage, charge, rawFinishReason, logprobs, metadata, channels };
};

export const toUsageFromPiMessage = (
    message: AssistantMessage | undefined,
    rawUsage: Record<string, unknown> | undefined,
): ProviderUsage | undefined => {
    const sdkUsage = (() => {
        if (message === undefined) return undefined;
        const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
        const reasoning = (message.usage as { reasoning?: number }).reasoning;
        if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && totalTokens === 0) {
            return undefined;
        }
        const totalInput = input + cacheRead + cacheWrite;
        return {
            inputTokens: totalInput,
            outputTokens: output,
            totalTokens: totalTokens || totalInput + output,
            inputTokenDetails: {
                noCacheTokens: input,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
            },
            ...(typeof reasoning === "number" && reasoning > 0
                ? {
                    outputTokenDetails: {
                        textTokens: Math.max(0, output - reasoning),
                        reasoningTokens: reasoning,
                    },
                }
                : {}),
        };
    })();
    if (rawUsage !== undefined) {
        try {
            const normalized = normalizeUsage(rawUsage, sdkUsage);
            if (normalized !== undefined) return normalized;
        } catch (error) {
            if (error instanceof UsageDetailError) return error.usage;
            throw error;
        }
    }
    return sdkUsage;
};
