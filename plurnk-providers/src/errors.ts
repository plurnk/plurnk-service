import { getOverflowPatterns } from "@earendil-works/pi-ai/utils/overflow";
import { isRecord } from "@plurnk/plurnk-contracts";
import { ProviderError } from "./providerError.ts";
import type { ProviderErrorKind } from "./providerError.ts";
import type { ProviderRequestCapacity } from "./types.ts";

export { ProviderError, RETRYABLE_PROVIDER_KINDS } from "./providerError.ts";
export type { ProviderErrorKind } from "./providerError.ts";

const headerEntry = (headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined => {
    if (headers === undefined) return undefined;
    const lower = name.toLowerCase();
    return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
};

const defaultIsRetryable = (
    statusCode: number | undefined,
    responseHeaders: Readonly<Record<string, string>> | undefined,
): boolean => {
    const directive = headerEntry(responseHeaders, "x-should-retry")?.trim().toLowerCase();
    if (directive === "true") return true;
    if (directive === "false") return false;
    return statusCode !== undefined && (
        statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500
    );
};

export class ProviderHttpError extends Error {
    readonly url: string;
    readonly statusCode?: number;
    readonly responseHeaders?: Record<string, string>;
    readonly responseBody?: string;
    readonly isRetryable: boolean;

    constructor({
        message,
        url,
        statusCode,
        responseHeaders,
        responseBody,
        cause,
        isRetryable = defaultIsRetryable(statusCode, responseHeaders),
    }: {
        message: string;
        url: string;
        statusCode?: number;
        responseHeaders?: Record<string, string>;
        responseBody?: string;
        cause?: unknown;
        isRetryable?: boolean;
    }) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "ProviderHttpError";
        this.url = url;
        this.statusCode = statusCode;
        this.responseHeaders = responseHeaders;
        this.responseBody = responseBody;
        this.isRetryable = isRetryable;
    }
}

export class ProviderRetryError extends Error {
    readonly reason: "maxRetriesExceeded" | "errorNotRetryable";
    readonly errors: readonly unknown[];
    readonly lastError: unknown;

    constructor({
        message,
        reason,
        errors,
    }: {
        message: string;
        reason: "maxRetriesExceeded" | "errorNotRetryable";
        errors: readonly unknown[];
    }) {
        super(message);
        this.name = "ProviderRetryError";
        this.reason = reason;
        this.errors = errors;
        this.lastError = errors.at(-1);
    }
}

export interface ClassifiedProviderError {
    kind: ProviderErrorKind;
    message: string;
    attempts?: number;
    retryExhausted?: boolean;
    extensions?: Readonly<Record<string, unknown>>;
}

export class ProviderTimeoutError extends Error {
    readonly phase = "operation";
    readonly timeoutMs: number;

    constructor(timeoutMs: number, cause?: unknown) {
        super(`Provider operation exceeded its ${timeoutMs} ms deadline.`, cause === undefined ? undefined : { cause });
        this.name = "ProviderTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

const peerTerminated = (err: unknown): boolean => {
    const seen = new Set<unknown>();
    let cur: unknown = err;
    while (typeof cur === "object" && cur !== null && !seen.has(cur)) {
        seen.add(cur);
        if (cur instanceof TypeError && cur.message.trim().toLowerCase() === "terminated") return true;
        cur = (cur as { cause?: unknown }).cause;
    }
    return false;
};

const wireError = (body: string): { type: string | null; code: string | null; message: string | null } => {
    try {
        const parsed: unknown = JSON.parse(body);
        const record = isRecord(parsed) && isRecord(parsed.error)
            ? parsed.error
            : isRecord(parsed)
                ? parsed
                : undefined;
        return {
            type: typeof record?.type === "string"
                ? record.type
                : typeof record?.status === "string"
                    ? record.status
                    : null,
            code: typeof record?.code === "string" || typeof record?.code === "number" ? String(record.code) : null,
            message: typeof record?.message === "string" ? record.message : null,
        };
    } catch {
        return { type: null, code: null, message: null };
    }
};

const CAPACITY_CODE = /^(?:context_length_exceeded|context_window_exceeded|input_too_long|prompt_too_long|request_too_large|token_limit_exceeded|max_tokens_exceeded)$/i;
const CAPACITY_MESSAGE = /(?:maximum context length|context (?:length|window).*(?:exceed|too (?:large|long)|maximum)|(?:input|prompt|request).*(?:token|length|size).*(?:exceed|too (?:large|long)|maximum))/i;
const OVERFLOW_PATTERNS: readonly RegExp[] = getOverflowPatterns();
const matchesCapacityMessage = (text: string): boolean =>
    CAPACITY_MESSAGE.test(text) || OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));

const preview = (value: unknown, limit: number | undefined): string => {
    const text = value instanceof Error ? value.message : String(value);
    return limit !== undefined && text.length > limit
        ? `${text.slice(0, limit)}...`
        : text;
};

type ProviderFailureCauseKind = "transport_terminated" | "invalid_json" | "internal";

interface ProviderFailureCause {
    readonly causeKind: ProviderFailureCauseKind;
    readonly causeName: string;
    readonly causeMessage: string;
}

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? "";

// {§provider-failure-normalization} Bounded classification of an underlying failure cause without
// leaking raw payload snippets (such as V8's SyntaxError input preview) or headers into Problem Details.
const failureCause = (err: ProviderHttpError, detailLimit: number | undefined): ProviderFailureCause | null => {
    const cause = err.cause;
    if (!(cause instanceof Error)) return null;
    if (peerTerminated(cause)) {
        return {
            causeKind: "transport_terminated",
            causeName: cause.name,
            causeMessage: preview(firstLine(cause.message), detailLimit),
        };
    }
    if (cause instanceof SyntaxError) {
        return {
            causeKind: "invalid_json",
            causeName: cause.name,
            causeMessage: "JSON parsing failed",
        };
    }
    return {
        causeKind: "internal",
        causeName: cause.name,
        causeMessage: preview(firstLine(cause.message), detailLimit),
    };
};

export const classifyProviderError = (
    err: unknown,
    detailLimit?: number,
): ClassifiedProviderError => {
    if (err instanceof ProviderRetryError) {
        return {
            ...classifyProviderError(err.lastError, detailLimit),
            attempts: err.errors.length,
            retryExhausted: err.reason === "maxRetriesExceeded",
        };
    }
    if (err instanceof ProviderHttpError) {
        const classified = classifyHttpError(err, detailLimit);
        const cause = failureCause(err, detailLimit);
        return cause === null ? classified : { ...classified, extensions: { ...classified.extensions, cause } };
    }
    const wire = isRecord(err) ? err : undefined;
    return {
        kind: "network_failure",
        message: preview(
            (typeof wire?.message === "string" ? wire.message : String(err)) || "The provider request failed.",
            detailLimit,
        ),
    };
};

const classifyHttpError = (err: ProviderHttpError, detailLimit: number | undefined): ClassifiedProviderError => {
    const status = err.statusCode ?? 0;
    const message = err.message.trim().length > 0
        ? preview(err.message, detailLimit)
        : "The provider request failed without a diagnostic message.";
    const body = err.responseBody ?? "";
    const wire = wireError(body);
    // A peer-terminated body inside a 2xx exchange is a network truth, not
    // an invalid response — Undici's TypeError("terminated") must stay
    // engine-recoverable (#479). Walk the cause chain for the termination signature.
    if (peerTerminated(err)) {
        return { kind: "network_failure", message };
    }
    if (status === 401 || status === 403) return { kind: "unauthorized", message };
    if (status === 402) return { kind: "quota_exceeded", message };
    if (status === 429) return { kind: "rate_limit", message };
    if (status === 408 || status === 409) return { kind: "network_failure", message };
    // Status 0 is a transport-level failure (no HTTP exchange settled); its KIND stays
    // network_failure whatever the transport's own retry policy was (#479).
    if (status === 0) return { kind: "network_failure", message };
    if (status >= 500) return { kind: "network_failure", message };
    if (status === 413 || (
        (status === 400 || status === 422)
        && (
            (wire.code !== null && CAPACITY_CODE.test(wire.code))
            || (wire.type !== null && CAPACITY_CODE.test(wire.type))
            || matchesCapacityMessage(wire.message ?? message)
        )
    )) {
        return {
            kind: "capacity_exceeded",
            message,
            extensions: status === 413 ? undefined : { providerStatus: status },
        };
    }
    if (status >= 400 && status < 500) return { kind: "request_rejected", message };
    return { kind: "invalid_response", message };
};

export const toProviderError = (
    err: unknown,
    source: string,
    detailLimit?: number,
    capacity?: ProviderRequestCapacity,
): ProviderError => {
    if (err instanceof ProviderError) return err;
    const underlying = err instanceof ProviderRetryError ? err.lastError : err;
    const classified = classifyProviderError(err, detailLimit);
    const { kind, message } = classified;
    const upstreamStatus = underlying instanceof ProviderHttpError ? underlying.statusCode ?? null : null;
    const status = kind === "capacity_exceeded" ? 413 : upstreamStatus;
    return new ProviderError(source, kind, message, {
        status,
        cause: err,
        extensions: {
            ...classified.extensions,
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
