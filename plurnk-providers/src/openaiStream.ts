// SSE client for OpenAI-compatible /chat/completions. Streaming keeps long
// completions alive through CDN proxies; the aggregated result is returned as
// one StreamResponse (the Provider contract is atomic — no partial resolves).
// Adapted from rummy's proven implementation; previously copy-pasted byte-for-
// byte into every @plurnk/plurnk-providers-* sibling, now shared from here.

type StreamRequest = {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    signal: AbortSignal;
    // #36: assemble the verbatim wire body onto StreamResponse.rawBody. Off by
    // default so a serving turn never pays the reassembly/retention cost.
    captureRawBody?: boolean;
};

import type { RawUsage } from "./usage.ts";
import type { TokenLogprob } from "./types.ts";

export type StreamResponse = {
    model: string | null;
    content: string;
    reasoning_content: string;
    finish_reason: string | null;
    usage: RawUsage | null;
    chunkMetadata: Record<string, unknown>;
    // #36: per-token logprobs parsed from choices[0].logprobs.content[], present
    // only when the request asked for them (else the field is absent → null).
    logprobs: TokenLogprob[] | null;
    // #36: the verbatim response body, populated only when captureRawBody is set.
    rawBody: unknown;
};

// Map an OpenAI-style `logprobs.content[]` array to the canonical structured view
// (#36). Reads the RAW `logprob` (not `sampling_logprob`); `top_logprobs` → `top`.
// Returns null when the shape is absent — never synthesizes.
const parseLogprobs = (raw: unknown): TokenLogprob[] | null => {
    const content = (raw as { content?: unknown } | null | undefined)?.content;
    if (!Array.isArray(content)) return null;
    return content.map((entry) => {
        const { token, logprob, top_logprobs } = entry as { token: string; logprob: number; top_logprobs?: unknown };
        const top = Array.isArray(top_logprobs)
            ? top_logprobs.map((a) => ({ token: (a as TokenLogprob).token, logprob: (a as TokenLogprob).logprob }))
            : undefined;
        return top !== undefined ? { token, logprob, top } : { token, logprob };
    });
};

export class OpenAiHttpError extends Error {
    readonly status: number;
    readonly body: string;
    readonly retryAfter: number | null;
    constructor(status: number, body: string, retryAfter: number | null) {
        super(`OpenAI ${status} - ${body}`);
        this.status = status;
        this.body = body;
        this.retryAfter = retryAfter;
    }
}

const parseRetryAfter = (header: string | null): number | null => {
    if (header === null) return null;
    const asInt = Number.parseInt(header, 10);
    if (Number.isFinite(asInt)) return asInt * 1000;
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
    return null;
};

// Non-streaming sibling. Same request/error handling, but POSTs without
// `stream` and parses the single JSON body into the SAME StreamResponse shape.
// For backends whose STREAMING response misbehaves (e.g. Fireworks labels
// grammar-constrained output as `reasoning_content` instead of `content`) —
// the Provider contract is atomic either way, so the transport is free to
// choose. The fetch timeout (AbortSignal) bounds the wait; there is no proxy
// between us and the backend that would idle out a non-streamed request.
export const chatCompletion = async ({ url, headers, body, signal, captureRawBody }: StreamRequest): Promise<StreamResponse> => {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new OpenAiHttpError(response.status, errorBody, parseRetryAfter(response.headers.get("retry-after")));
    }
    const j = (await response.json()) as Record<string, unknown>;
    const choices = j.choices as Array<Record<string, unknown>> | undefined;
    const choice = (choices?.[0] ?? {}) as Record<string, unknown>;
    const msg = (choice.message ?? {}) as Record<string, unknown>;
    const reasoning = msg.reasoning_content ?? msg.reasoning ?? msg.thinking ?? "";
    const chunkMetadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j)) if (k !== "choices" && k !== "usage") chunkMetadata[k] = v;
    return {
        model: typeof j.model === "string" ? j.model : null,
        content: typeof msg.content === "string" ? msg.content : "",
        reasoning_content: typeof reasoning === "string" ? reasoning : "",
        finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
        usage: (j.usage ?? null) as StreamResponse["usage"],
        chunkMetadata,
        logprobs: parseLogprobs(choice.logprobs),
        // Non-streamed: the parsed JSON IS the verbatim wire body, exact.
        rawBody: captureRawBody === true ? j : undefined,
    };
};

export const chatCompletionStream = async ({ url, headers, body, signal, captureRawBody }: StreamRequest): Promise<StreamResponse> => {
    const requestBody = { ...body, stream: true, stream_options: { include_usage: true } };

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(requestBody),
        signal,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new OpenAiHttpError(response.status, errorBody, parseRetryAfter(response.headers.get("retry-after")));
    }

    if (response.body === null) throw new Error("OpenAI response body is null");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let content = "";
    let reasoning_content = "";
    let usage: StreamResponse["usage"] = null;
    let model: string | null = null;
    let finish_reason: string | null = null;
    const chunkMetadata: Record<string, unknown> = {};
    // #36: logprobs stream as per-chunk choices[0].logprobs.content[] deltas —
    // accumulate the raw entries across chunks, map once at the end.
    const logprobEntries: unknown[] = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trimStart();
            if (payload === "[DONE]" || payload === "") continue;

            let chunk: Record<string, unknown>;
            try { chunk = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }

            if (typeof chunk.model === "string") model = chunk.model;
            if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage as StreamResponse["usage"];

            for (const [k, v] of Object.entries(chunk)) {
                if (k === "choices" || k === "usage") continue;
                chunkMetadata[k] = v;
            }

            const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
            const choice = choices?.[0];
            if (choice === undefined) continue;
            if (typeof choice.finish_reason === "string") finish_reason = choice.finish_reason;

            const chunkLogprobs = (choice.logprobs as { content?: unknown } | undefined)?.content;
            if (Array.isArray(chunkLogprobs)) logprobEntries.push(...chunkLogprobs);

            const delta = choice.delta as Record<string, unknown> | undefined;
            if (delta === undefined) continue;
            if (typeof delta.content === "string") content += delta.content;
            // Reasoning surfaces under different field names per provider.
            if (typeof delta.reasoning_content === "string") reasoning_content += delta.reasoning_content;
            if (typeof delta.reasoning === "string") reasoning_content += delta.reasoning;
            if (typeof delta.thinking === "string") reasoning_content += delta.thinking;
        }
    }

    const logprobs = logprobEntries.length > 0 ? parseLogprobs({ content: logprobEntries }) : null;
    // Streamed turns have no single verbatim wire body; reassemble the equivalent
    // (#36) — chunk-level fields (chunkMetadata) + the collected choice — only when
    // asked, so serving turns pay nothing.
    const rawBody = captureRawBody === true
        ? { ...chunkMetadata, model, usage, choices: [{ index: 0, message: { content, reasoning_content }, finish_reason, logprobs: logprobs !== null ? { content: logprobEntries } : null }] }
        : undefined;
    return { model, content, reasoning_content, finish_reason, usage, chunkMetadata, logprobs, rawBody };
};
