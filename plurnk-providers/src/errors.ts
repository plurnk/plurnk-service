import { APICallError, RetryError } from "ai";
import { ProviderError } from "./providerError.ts";
import type { ProviderErrorKind } from "./providerError.ts";
import type { ProviderRequestCapacity } from "./types.ts";

export { ProviderError } from "./providerError.ts";
export type { ProviderErrorKind } from "./providerError.ts";

export interface ClassifiedProviderError {
    kind: ProviderErrorKind;
    message: string;
    retryable?: boolean;
    attempts?: number;
    retryExhausted?: boolean;
    extensions?: Readonly<Record<string, unknown>>;
}

export type ProviderTimeoutPhase = "attempt" | "first_content" | "stream_idle" | "operation";

export class ProviderTimeoutError extends Error {
    readonly phase: ProviderTimeoutPhase;
    readonly timeoutMs: number;

    constructor(phase: ProviderTimeoutPhase, timeoutMs: number, cause?: unknown) {
        const labels: Record<ProviderTimeoutPhase, string> = {
            attempt: "Provider attempt",
            first_content: "First provider content",
            stream_idle: "Provider stream idle",
            operation: "Provider operation",
        };
        super(`${labels[phase]} exceeded its ${timeoutMs} ms deadline.`, cause === undefined ? undefined : { cause });
        this.name = "ProviderTimeoutError";
        this.phase = phase;
        this.timeoutMs = timeoutMs;
    }
}

export const providerTimeoutOf = (error: unknown): ProviderTimeoutError | null => {
    const seen = new Set<unknown>();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        if (current instanceof ProviderTimeoutError) return current;
        seen.add(current);
        current = (current as { cause?: unknown }).cause;
    }
    return null;
};

const wireError = (body: string): { type: string | null; code: string | null; message: string | null } => {
    try {
        const { error } = JSON.parse(body) as { error?: { type?: unknown } };
        const record = error as { type?: unknown; code?: unknown; message?: unknown } | undefined;
        return {
            type: typeof record?.type === "string" ? record.type : null,
            code: typeof record?.code === "string" || typeof record?.code === "number" ? String(record.code) : null,
            message: typeof record?.message === "string" ? record.message : null,
        };
    } catch {
        return { type: null, code: null, message: null };
    }
};

const CAPACITY_CODE = /^(?:context_length_exceeded|context_window_exceeded|input_too_long|prompt_too_long|request_too_large|token_limit_exceeded|max_tokens_exceeded)$/i;
const CAPACITY_MESSAGE = /(?:maximum context length|context (?:length|window).*(?:exceed|too (?:large|long)|maximum)|(?:input|prompt|request).*(?:token|length|size).*(?:exceed|too (?:large|long)|maximum))/i;

const preview = (value: unknown, limit: number | undefined): string => {
    const text = value instanceof Error ? value.message : String(value);
    return limit !== undefined && text.length > limit
        ? `${text.slice(0, limit)}...`
        : text;
};

export const classifyProviderError = (
    err: unknown,
    detailLimit?: number,
): ClassifiedProviderError => {
    if (RetryError.isInstance(err)) {
        return {
            ...classifyProviderError(err.lastError, detailLimit),
            retryable: false,
            attempts: err.errors.length,
            retryExhausted: err.reason === "maxRetriesExceeded",
        };
    }
    if (APICallError.isInstance(err)) {
        const timeout = providerTimeoutOf(err);
        if (timeout !== null) {
            return {
                kind: "network_failure",
                message: timeout.message,
                extensions: {
                    timeoutPhase: timeout.phase,
                    timeoutMs: timeout.timeoutMs,
                },
            };
        }
        const status = err.statusCode ?? 0;
        const message = err.message.trim().length > 0
            ? preview(err.message, detailLimit)
            : "The provider request failed without a diagnostic message.";
        const body = err.responseBody ?? "";
        const wire = wireError(body);
        if (status === 401 || status === 403) return { kind: "unauthorized", message };
        if (status === 402) return { kind: "quota_exceeded", message };
        if (status === 429) return { kind: "rate_limit", message, retryable: err.isRetryable };
        if (status === 408 || status === 409) {
            return { kind: "network_failure", message, retryable: err.isRetryable };
        }
        if (status === 0 && err.isRetryable) return { kind: "network_failure", message };
        if (status >= 500) return { kind: "network_failure", message, retryable: err.isRetryable };
        if (status === 413 || (
            (status === 400 || status === 422)
            && (
                (wire.code !== null && CAPACITY_CODE.test(wire.code))
                || (wire.type !== null && CAPACITY_CODE.test(wire.type))
                || CAPACITY_MESSAGE.test(wire.message ?? message)
            )
        )) {
            return {
                kind: "capacity_exceeded",
                message,
                extensions: status === 413 ? undefined : { providerStatus: status },
            };
        }
        if (status === 422 && wire.type === "grammar_invalid") {
            return { kind: "grammar_invalid", message };
        }
        return { kind: "invalid_response", message };
    }
    const wire = err as { message?: unknown; type?: unknown };
    if (wire?.type === "grammar_invalid") {
        return {
            kind: "grammar_invalid",
            message: typeof wire.message === "string"
                ? preview(wire.message, detailLimit)
                : "The provider rejected the response grammar.",
        };
    }
    const error = err as { message?: string };
    return {
        kind: "network_failure",
        message: preview(
            (error?.message ?? String(err)) || "The provider request failed.",
            detailLimit,
        ),
    };
};

export const toProviderError = (
    err: unknown,
    source: string,
    detailLimit?: number,
    capacity?: ProviderRequestCapacity,
): ProviderError => {
    if (err instanceof ProviderError) return err;
    const underlying = RetryError.isInstance(err) ? err.lastError : err;
    const classified = classifyProviderError(err, detailLimit);
    const { kind, message } = classified;
    const upstreamStatus = APICallError.isInstance(underlying) ? underlying.statusCode ?? null : null;
    const status = kind === "capacity_exceeded" ? 413 : upstreamStatus;
    return new ProviderError(source, kind, message, {
        status,
        cause: err,
        retryable: classified.retryable,
        extensions: {
            ...(classified.extensions ?? {}),
            ...(kind === "capacity_exceeded" ? { capacityStage: "upstream" } : {}),
            ...(capacity === undefined ? {} : { capacity }),
            ...(classified.attempts === undefined ? {} : { attempts: classified.attempts }),
            ...(classified.retryExhausted === undefined
                ? {}
                : { retryExhausted: classified.retryExhausted }),
        },
        capacity,
    });
};
