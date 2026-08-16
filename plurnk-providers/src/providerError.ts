import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";
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

export type { ProviderAttempt, ProviderRequestAccounting, ProviderRequestCapacity } from "./types.ts";
