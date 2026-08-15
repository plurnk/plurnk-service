import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { APICallError, RetryError } from "ai";
import { providerSource } from "./notices.ts";
import type { ProviderAttempt, ProviderRequestAccounting, ProviderRequestCapacity } from "./types.ts";

export type ProviderErrorKind =
    | "rate_limit"
    | "network_failure"
    | "deadline_exceeded"
    | "model_refused"
    | "invalid_response"
    | "unauthorized"
    | "quota_exceeded"
    | "grammar_invalid"
    | "capacity_exceeded"
    | "resource_interrupted";

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

const defaultStatus = (kind: ProviderErrorKind): number => {
    switch (kind) {
        case "unauthorized": return 401;
        case "quota_exceeded": return 402;
        case "capacity_exceeded": return 413;
        case "rate_limit": return 429;
        case "model_refused":
        case "grammar_invalid": return 422;
        case "invalid_response": return 502;
        case "deadline_exceeded": return 504;
        case "network_failure":
        case "resource_interrupted": return 503;
    }
};

const retryable = (kind: ProviderErrorKind): boolean => {
    switch (kind) {
        case "rate_limit":
        case "network_failure":
            return true;
        case "deadline_exceeded":
        case "invalid_response":
        case "grammar_invalid":
        case "capacity_exceeded":
        case "resource_interrupted":
        case "model_refused":
        case "unauthorized":
        case "quota_exceeded":
            return false;
    }
};

const buildProblem = (
    source: string,
    kind: ProviderErrorKind,
    message: string,
    status: number,
    extensions: Readonly<Record<string, unknown>>,
    retryableOverride: boolean | undefined,
): ProblemDetails => {
    const code: Record<ProviderErrorKind, string> = {
        rate_limit: "rate-limit",
        network_failure: "network-failure",
        deadline_exceeded: "deadline-exceeded",
        model_refused: "model-refused",
        invalid_response: "invalid-response",
        unauthorized: "unauthorized",
        quota_exceeded: "quota-exceeded",
        grammar_invalid: "grammar-invalid",
        capacity_exceeded: "capacity-exceeded",
        resource_interrupted: "resource-interrupted",
    };
    return Problems.create(source, code[kind], status, message, {
        providerKind: kind,
        stage: "provider-request",
        retryable: retryableOverride ?? retryable(kind),
        ...extensions,
    });
};

// A provider operation failed before a completed exchange existed. An
// interrupted response may still carry attempt evidence for its consumer.
// The standardized Problem is the public failure contract; kind remains the
// provider pool's routing discriminator and is repeated as a Problem extension.
export class ProviderError extends Error {
    readonly source: string;
    readonly kind: ProviderErrorKind;
    readonly problem: ProblemDetails;
    readonly attempt?: ProviderAttempt;
    readonly capacity?: ProviderRequestCapacity;
    #accounting: ProviderRequestAccounting[];

    constructor(
        source: string,
        kind: ProviderErrorKind,
        message: string,
        options: {
            status?: number | null;
            cause?: unknown;
            retryable?: boolean;
            extensions?: Readonly<Record<string, unknown>>;
            attempt?: ProviderAttempt;
            accounting?: readonly ProviderRequestAccounting[];
            capacity?: ProviderRequestCapacity;
        } = {},
    ) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "ProviderError";
        this.source = providerSource(source);
        this.kind = kind;
        this.attempt = options.attempt;
        this.capacity = options.capacity ?? options.attempt?.capacity;
        this.#accounting = [...(options.accounting ?? options.attempt?.accounting ?? [])];
        const status = options.status !== null && options.status !== undefined
            && Number.isInteger(options.status) && options.status >= 400 && options.status <= 599
            ? options.status
            : defaultStatus(kind);
        this.problem = buildProblem(
            this.source,
            kind,
            message,
            status,
            options.extensions ?? {},
            options.retryable,
        );
    }

    get status(): number {
        return this.problem.status;
    }

    get accounting(): readonly ProviderRequestAccounting[] {
        return this.#accounting;
    }

    // A capacity pool adds the already-settled requests from prior backends as
    // the same failure crosses that orchestration boundary.
    prependAccounting(accounting: readonly ProviderRequestAccounting[]): void {
        if (accounting.length > 0) this.#accounting = [...accounting, ...this.#accounting];
    }
}

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
