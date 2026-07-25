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

// Sealed reasoning (#482, widened per client). A relay backend (OpenRouter
// fronting OpenAI o-series) returns the chain-of-thought ENCRYPTED as
// reasoning_details entries ({ type: "reasoning.encrypted", id, data, format,
// index }) while readable text still rides reasoning/reasoning_content (verified
// live: o4-mini via OpenRouter — reasoning null, one encrypted entry, format
// "openai-responses-v1"). The ITEM shape preserves the wire's `id` (a flat blob
// list dropped item identity — the widening's whole point) and a `subtype` from
// wire POSITION: we parse message.reasoning_details, so it is message-attached.
// plurnk is tools-in-body (SPEC §2), so reasoning is never tool-call-attached and
// subtype is constant here; the field is structural, future-proofing the seam.
// An ARRAY of items (not a single object) so N distinct reasoning ids never
// re-collide the identity this fixes. Blobs verbatim, never decoded.
export type EncryptedReasoningItem = { id: string | null; subtype: string; encrypted: Array<{ data: string; format: string | null }> };

type RawEncrypted = { id: string | null; data: string; format: string | null };

// Group accumulated encrypted entries into items by wire `id` (id-less entries
// stand alone, never merged). Order preserved.
const groupEncrypted = (entries: Iterable<RawEncrypted>): EncryptedReasoningItem[] => {
    const items: EncryptedReasoningItem[] = [];
    const byId = new Map<string, EncryptedReasoningItem>();
    for (const e of entries) {
        const blob = { data: e.data, format: e.format };
        if (e.id === null) { items.push({ id: null, subtype: "message", encrypted: [blob] }); continue; }
        let item = byId.get(e.id);
        if (item === undefined) { item = { id: e.id, subtype: "message", encrypted: [] }; byId.set(e.id, item); items.push(item); }
        item.encrypted.push(blob);
    }
    return items;
};

const encryptedFromDetails = (details: unknown): EncryptedReasoningItem[] => {
    if (!Array.isArray(details)) return [];
    const raw: RawEncrypted[] = [];
    for (const e of details) {
        const entry = e as { type?: unknown; id?: unknown; data?: unknown; format?: unknown };
        if (entry?.type !== "reasoning.encrypted" || typeof entry.data !== "string") continue;
        raw.push({ id: typeof entry.id === "string" ? entry.id : null, data: entry.data, format: typeof entry.format === "string" ? entry.format : null });
    }
    return groupEncrypted(raw);
};

export type StreamResponse = {
    model: string | null;
    content: string;
    reasoning_content: string;
    // Sealed relay reasoning (#482) — empty for the open-reasoning backends.
    reasoning_encrypted: EncryptedReasoningItem[];
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

// Cloudflare/CDN EDGE status codes (520-527): infrastructure failures the proxy
// returns (as HTML error pages), NOT OpenAI/API statuses. A retry re-incurs the
// same origin wait, so they fail-fast (#543).
const EDGE_LABELS: ReadonlyMap<number, string> = new Map([
    [520, "web server returned an unknown error"], [521, "web server is down"],
    [522, "connection timed out"], [523, "origin is unreachable"], [524, "origin timeout"],
    [525, "SSL handshake failed"], [526, "invalid SSL certificate"], [527, "railgun error"],
]);
export const isEdgeStatus = (status: number): boolean => status >= 520 && status <= 527;

export class OpenAiHttpError extends Error {
    readonly status: number;
    readonly body: string;
    readonly retryAfter: number | null;
    constructor(status: number, body: string, retryAfter: number | null) {
        super(OpenAiHttpError.#describe(status, body));
        this.status = status;
        this.body = body;
        this.retryAfter = retryAfter;
    }
    // A non-JSON error body (a proxy/CDN HTML page) collapses to one line and drops
    // the misleading "OpenAI" prefix - an edge code is not an API status (#543).
    // JSON API errors pass through verbatim.
    static #describe(status: number, body: string): string {
        if (body.trimStart().startsWith("<")) return `${status} ${EDGE_LABELS.get(status) ?? "edge/proxy error"}`;
        return `OpenAI ${status} - ${body}`;
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
        reasoning_encrypted: encryptedFromDetails(msg.reasoning_details),
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
    // #482: encrypted reasoning_details stream chunked — concatenate `data` per
    // reassembly key (index when present, else id, else a counter); the id/format
    // ride along and items group by id at the end.
    const encryptedByKey = new Map<string, RawEncrypted>();
    let encryptedNoKey = 0;

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

            // A streaming server may flush HTTP 200 headers before inference
            // completes, then report a terminal failure as an SSE error frame.
            // That frame is a failed exchange, never an empty completion.
            if (chunk.error !== null && typeof chunk.error === "object") {
                const status = typeof chunk.status === "number"
                    && Number.isInteger(chunk.status)
                    && chunk.status >= 400
                    && chunk.status <= 599
                    ? chunk.status
                    : 500;
                throw new OpenAiHttpError(status, JSON.stringify({ error: chunk.error }), null);
            }

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
            if (Array.isArray(delta.reasoning_details)) {
                for (const e of delta.reasoning_details) {
                    const entry = e as { type?: unknown; id?: unknown; data?: unknown; format?: unknown; index?: unknown };
                    if (entry?.type !== "reasoning.encrypted" || typeof entry.data !== "string") continue;
                    const id = typeof entry.id === "string" ? entry.id : null;
                    const key = typeof entry.index === "number" ? `i${entry.index}` : id ?? `n${encryptedNoKey++}`;
                    const prev = encryptedByKey.get(key);
                    if (prev !== undefined) prev.data += entry.data;
                    else encryptedByKey.set(key, { id, data: entry.data, format: typeof entry.format === "string" ? entry.format : null });
                }
            }
        }
    }

    const logprobs = logprobEntries.length > 0 ? parseLogprobs({ content: logprobEntries }) : null;
    // Streamed turns have no single verbatim wire body; reassemble the equivalent
    // (#36) — chunk-level fields (chunkMetadata) + the collected choice — only when
    // asked, so serving turns pay nothing.
    const rawBody = captureRawBody === true
        ? { ...chunkMetadata, model, usage, choices: [{ index: 0, message: { content, reasoning_content }, finish_reason, logprobs: logprobs !== null ? { content: logprobEntries } : null }] }
        : undefined;
    return { model, content, reasoning_content, reasoning_encrypted: groupEncrypted(encryptedByKey.values()), finish_reason, usage, chunkMetadata, logprobs, rawBody };
};
