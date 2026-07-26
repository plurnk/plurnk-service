import { createOpenAICompatible, type ProviderErrorStructure } from "@ai-sdk/openai-compatible";
import { generateText, streamText, type LanguageModelUsage } from "ai";
import { z } from "zod/v4";
import type { ChatMessage, FinishReason, ProviderUsage, TokenLogprob } from "./types.ts";
import { normalizeUsage, type RawUsage } from "./usage.ts";

const errorSchema = z.object({
    error: z.object({
        message: z.string(),
        type: z.string().nullish(),
        param: z.unknown().nullish(),
        code: z.union([z.string(), z.number()]).nullish(),
    }).passthrough(),
}).passthrough();

const errorStructure: ProviderErrorStructure<z.infer<typeof errorSchema>> = {
    errorSchema,
    errorToMessage: ({ error }) => error.message,
    isRetryable(response) {
        const directive = response.headers.get("x-should-retry")?.trim().toLowerCase();
        if (directive === "false") return false;
        if (directive === "true") return true;
        if (response.status >= 520 && response.status <= 527) return false;
        return response.status === 408
            || response.status === 409
            || response.status === 429
            || response.status >= 500;
    },
};

const baseUrl = (completionUrl: string): string => {
    const url = new URL(completionUrl);
    if (!url.pathname.endsWith("/chat/completions")) {
        throw new Error(`OpenAI-compatible URL must end in /chat/completions: ${completionUrl}`);
    }
    url.pathname = url.pathname.slice(0, -"/chat/completions".length);
    return url.toString().replace(/\/$/, "");
};

const usageOf = (
    usage: LanguageModelUsage,
    reasoningText: string,
    contentText: string,
): ProviderUsage => normalizeUsage({
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.inputTokenDetails.cacheReadTokens },
    completion_tokens_details: usage.outputTokenDetails.reasoningTokens !== undefined
        ? { reasoning_tokens: usage.outputTokenDetails.reasoningTokens }
        : undefined,
}, reasoningText, contentText);

const wireUsageOf = (
    value: unknown,
    reasoningText: string,
    contentText: string,
): ProviderUsage | null => {
    const usage = (value as { usage?: unknown } | null)?.usage;
    if (usage === null || typeof usage !== "object") return null;
    return normalizeUsage(usage as RawUsage, reasoningText, contentText);
};

const finishReasonOf = (reason: string | undefined): FinishReason => {
    switch (reason?.toLowerCase()) {
        case "stop":
        case "end_turn":
        case "stop_sequence":
        case "eos_token":
            return "stop";
        case "length":
        case "max_tokens":
        case "model_length":
        case "max_completion_tokens":
            return "length";
        case "tool_calls":
        case "tool_use":
            return "tool_calls";
        case "content_filter":
        case "safety":
        case "recitation":
            return "content_filter";
        default:
            return null;
    }
};

export type AiSdkTransportRequest = {
    url: string;
    model: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    messages: ChatMessage[];
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    fetchTimeoutMs: number;
    streamIdleTimeoutMs?: number;
    retryAttempts: number;
    streaming: boolean;
    captureRawBody: boolean;
};

export type AiSdkTransportResponse = {
    model: string;
    content: string;
    reasoning: string;
    finishReason: FinishReason;
    usage: ProviderUsage;
    rawChunks: unknown[];
    chunkMetadata: Record<string, unknown>;
    reasoningEncrypted: Array<{
        id: string | null;
        subtype: string;
        encrypted: Array<{ data: string; format: string | null }>;
    }>;
    logprobs: TokenLogprob[];
    rawBody?: unknown;
    providerMetadata?: Record<string, unknown>;
};

export const executeOpenAICompatible = async (
    request: AiSdkTransportRequest,
): Promise<AiSdkTransportResponse> => {
    let parsedBody: unknown;
    let wireBody: unknown;
    const chunks: unknown[] = [];
    const metadata: Record<string, unknown> = {};
    const collectMetadata = (value: unknown): void => {
        if (value === null || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
            if (key !== "choices" && key !== "usage") metadata[key] = item;
        }
    };
    const provider = createOpenAICompatible({
        name: "plurnk",
        baseURL: baseUrl(request.url),
        headers: request.headers,
        fetch: async (input, init) => {
            const response = await (request.fetch ?? globalThis.fetch)(input, init);
            if (!request.streaming) {
                try {
                    wireBody = await response.clone().json();
                } catch {
                    // The AI SDK owns response validation and the resulting error.
                }
            }
            return response;
        },
        includeUsage: true,
        transformRequestBody: (sdkBody) => ({
            ...sdkBody,
            ...request.body,
            stream: sdkBody.stream,
            ...(sdkBody.stream_options !== undefined
                ? { stream_options: sdkBody.stream_options }
                : {}),
        }),
        metadataExtractor: {
            async extractMetadata({ parsedBody: body }) {
                parsedBody = body;
                collectMetadata(body);
                return { plurnk: metadata as any };
            },
            createStreamExtractor: () => ({
                processChunk(chunk) {
                    chunks.push(chunk);
                    collectMetadata(chunk);
                },
                buildMetadata: () => ({ plurnk: metadata as any }),
            }),
        },
    });
    const model = provider.languageModel(request.model, { errorStructure });
    const common = {
        model,
        // The stable Provider contract permits an empty message list. AI SDK
        // validates its prompt before transformRequestBody runs, so give that
        // validator a harmless placeholder; the transformed wire body above
        // still carries the caller's exact `messages` value.
        messages: request.messages.length > 0
            ? request.messages
            : [{ role: "user" as const, content: "" }],
        maxRetries: request.retryAttempts,
        abortSignal: request.signal,
        timeout: {
            totalMs: request.fetchTimeoutMs,
            ...(request.streamIdleTimeoutMs !== undefined && request.streamIdleTimeoutMs > 0
                ? { chunkMs: request.streamIdleTimeoutMs }
                : {}),
        },
    } as const;

    if (!request.streaming) {
        const result = await generateText(common);
        const evidence = extractEvidence([wireBody ?? parsedBody]);
        const reasoning = evidence.reasoning || result.reasoningText || "";
        return {
            model: result.response.modelId,
            content: result.text,
            reasoning,
            finishReason: finishReasonOf(evidence.rawFinishReason ?? result.rawFinishReason),
            usage: wireUsageOf(wireBody, reasoning, result.text)
                ?? usageOf(result.usage, reasoning, result.text),
            rawChunks: [],
            chunkMetadata: metadata,
            reasoningEncrypted: evidence.reasoningEncrypted,
            logprobs: evidence.logprobs,
            ...(request.captureRawBody ? { rawBody: wireBody ?? parsedBody } : {}),
            ...(result.providerMetadata !== undefined
                ? { providerMetadata: result.providerMetadata as Record<string, unknown> }
                : {}),
        };
    }

    const result = streamText({
        ...common,
        includeRawChunks: true,
        onError: () => {},
    });
    const rawChunks: unknown[] = [];
    let streamError: unknown;
    for await (const part of result.fullStream) {
        if (part.type === "raw") rawChunks.push(part.rawValue);
        if (part.type === "error") streamError ??= part.error;
    }
    if (streamError !== undefined) throw streamError;
    const evidence = extractEvidence(rawChunks);
    return {
        model: (await result.response).modelId,
        content: await result.text,
        reasoning: evidence.reasoning || (await result.reasoningText) || "",
        finishReason: finishReasonOf(evidence.rawFinishReason ?? await result.rawFinishReason),
        usage: usageOf(
            await result.usage,
            evidence.reasoning || (await result.reasoningText) || "",
            await result.text,
        ),
        rawChunks,
        chunkMetadata: metadata,
        reasoningEncrypted: evidence.reasoningEncrypted,
        logprobs: evidence.logprobs,
        ...(request.captureRawBody ? { rawBody: rawChunks } : {}),
        ...((await result.providerMetadata) !== undefined
            ? { providerMetadata: (await result.providerMetadata) as Record<string, unknown> }
            : {}),
    };
};

const extractEvidence = (values: unknown[]): {
    reasoningEncrypted: AiSdkTransportResponse["reasoningEncrypted"];
    logprobs: TokenLogprob[];
    reasoning: string;
    rawFinishReason?: string;
} => {
    const encrypted = new Map<string, AiSdkTransportResponse["reasoningEncrypted"][number]>();
    const logprobs: TokenLogprob[] = [];
    let reasoning = "";
    let rawFinishReason: string | undefined;
    let anonymous = 0;
    for (const value of values) {
        const choices = (value as { choices?: unknown } | null)?.choices;
        if (!Array.isArray(choices)) continue;
        const choice = choices[0] as Record<string, any> | undefined;
        if (choice === undefined) continue;
        if (typeof choice.finish_reason === "string") rawFinishReason = choice.finish_reason;
        const entries = choice.logprobs?.content;
        if (Array.isArray(entries)) {
            for (const entry of entries) {
                if (typeof entry?.token !== "string" || typeof entry?.logprob !== "number") continue;
                const top = Array.isArray(entry.top_logprobs)
                    ? entry.top_logprobs
                        .filter((item: any) => typeof item?.token === "string" && typeof item?.logprob === "number")
                        .map((item: any) => ({ token: item.token, logprob: item.logprob }))
                    : undefined;
                logprobs.push(top === undefined
                    ? { token: entry.token, logprob: entry.logprob }
                    : { token: entry.token, logprob: entry.logprob, top });
            }
        }
        const message = choice.delta ?? choice.message ?? {};
        for (const key of ["reasoning_content", "reasoning", "thinking"]) { // lexicon-allow: backend wire fields
            if (typeof message[key] === "string") reasoning += message[key];
        }
        if (!Array.isArray(message.reasoning_details)) continue;
        for (const detail of message.reasoning_details) {
            if (detail?.type !== "reasoning.encrypted" || typeof detail.data !== "string") continue;
            const id = typeof detail.id === "string" ? detail.id : null;
            const key = typeof detail.index === "number"
                ? `index:${detail.index}`
                : id === null ? `anonymous:${anonymous++}` : `id:${id}`;
            const item: AiSdkTransportResponse["reasoningEncrypted"][number] = encrypted.get(key) ?? {
                id,
                subtype: "message",
                encrypted: [],
            };
            const format = typeof detail.format === "string" ? detail.format : null;
            const prior = item.encrypted.at(-1);
            if (prior !== undefined) {
                prior.data += detail.data;
                if (prior.format === null && format !== null) prior.format = format;
            } else {
                item.encrypted.push({ data: detail.data, format });
            }
            encrypted.set(key, item);
        }
    }
    return {
        reasoningEncrypted: [...encrypted.values()],
        logprobs,
        reasoning,
        ...(rawFinishReason !== undefined ? { rawFinishReason } : {}),
    };
};
