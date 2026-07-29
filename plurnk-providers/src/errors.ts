import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { APICallError, RetryError } from "ai";
import { providerSource } from "./notices.ts";

export type ProviderErrorKind =
    | "rate_limit"
    | "network_failure"
    | "model_refused"
    | "invalid_response"
    | "unauthorized"
    | "quota_exceeded"
    | "grammar_invalid";

const defaultStatus = (kind: ProviderErrorKind): number => {
    switch (kind) {
        case "unauthorized": return 401;
        case "quota_exceeded": return 402;
        case "rate_limit": return 429;
        case "model_refused":
        case "grammar_invalid": return 422;
        case "invalid_response": return 502;
        case "network_failure": return 503;
    }
};

const buildProblem = (
    source: string,
    kind: ProviderErrorKind,
    message: string,
    status: number,
): ProblemDetails => {
    return Problems.create(source, kind.replaceAll("_", "-"), status, message, {
        providerKind: kind,
    });
};

// A provider operation failed before a completed exchange existed. The
// standardized Problem is the public failure contract; kind remains the
// provider pool's routing discriminator and is repeated as a Problem extension.
export class ProviderError extends Error {
    readonly source: string;
    readonly kind: ProviderErrorKind;
    readonly problem: ProblemDetails;

    constructor(
        source: string,
        kind: ProviderErrorKind,
        message: string,
        options: { status?: number | null; cause?: unknown } = {},
    ) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "ProviderError";
        this.source = providerSource(source);
        this.kind = kind;
        const status = options.status !== null && options.status !== undefined
            && Number.isInteger(options.status) && options.status >= 400 && options.status <= 599
            ? options.status
            : defaultStatus(kind);
        this.problem = buildProblem(this.source, kind, message, status);
    }

    get status(): number {
        return this.problem.status;
    }
}

const wireErrorType = (body: string): string | null => {
    try {
        const { error } = JSON.parse(body) as { error?: { type?: unknown } };
        return typeof error?.type === "string" ? error.type : null;
    } catch {
        return null;
    }
};

export const classifyProviderError = (err: unknown): { kind: ProviderErrorKind; message: string } => {
    if (RetryError.isInstance(err)) return classifyProviderError(err.lastError);
    if (APICallError.isInstance(err)) {
        const status = err.statusCode ?? 0;
        const message = err.message.trim().length > 0
            ? err.message
            : `Provider request failed with status ${status}.`;
        const body = err.responseBody ?? "";
        if (status === 401 || status === 403) return { kind: "unauthorized", message };
        if (status === 402) return { kind: "quota_exceeded", message };
        if (status === 429) return { kind: "rate_limit", message };
        if (status >= 500) return { kind: "network_failure", message };
        if (status === 422 && wireErrorType(body) === "grammar_invalid") {
            return { kind: "grammar_invalid", message };
        }
        return { kind: "invalid_response", message };
    }
    const wire = err as { message?: unknown; type?: unknown };
    if (wire?.type === "grammar_invalid") {
        return {
            kind: "grammar_invalid",
            message: typeof wire.message === "string" ? wire.message : "grammar-invalid response",
        };
    }
    const error = err as { message?: string };
    return {
        kind: "network_failure",
        message: (error?.message ?? String(err)) || "request failed",
    };
};

export const toProviderError = (err: unknown, source: string): ProviderError => {
    if (err instanceof ProviderError) return err;
    const underlying = RetryError.isInstance(err) ? err.lastError : err;
    const { kind, message } = classifyProviderError(underlying);
    const status = APICallError.isInstance(underlying) ? underlying.statusCode ?? null : null;
    return new ProviderError(source, kind, message, { status, cause: err });
};
