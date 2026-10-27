import { Results as _Results } from "@plurnk/plurnk-schemes";
import type ConfigurationError from "@plurnk/plurnk-meta/configuration-error";
import type {
    EntryResult, ProblemDetails, ProposalResult, PassthroughResult, SchemeResult, SchemeResultBase,
} from "@plurnk/plurnk-schemes";

export type { EntryResult, ProblemDetails, ProposalResult, PassthroughResult, SchemeResult, SchemeResultBase };

// A failed result: an error status with the Problem that explains it.
export type FailedResult = SchemeResult & { readonly problem: ProblemDetails };

export class OperationFailureError extends Error {
    readonly result: FailedResult;

    constructor(result: SchemeResult, options: { cause?: unknown } = {}) {
        const checked = _Results.assert(result);
        if (!Results.isFailed(checked)) {
            throw new TypeError("OperationFailureError requires a failed operation result");
        }
        super(
            checked.problem.detail,
            options.cause !== undefined ? { cause: options.cause } : undefined,
        );
        this.name = "OperationFailureError";
        this.result = checked;
    }
}

export default class Results extends _Results {
    // {§configuration-repair-path}: invalid configuration is unavailable, never an invented policy.
    static configurationFailure(cause: ConfigurationError): SchemeResult {
        return Results.failure("daemon:configuration", "configuration-invalid", 503, cause.message, {}, {
            key: cause.key,
            retryable: false,
        });
    }

    static isFailed(result: SchemeResult): result is FailedResult {
        return Results.isErrorStatus(result.status) && result.problem !== undefined;
    }

    // The log rows an operation wrote: the result says when more than its own row landed.
    static rowsWritten(result: SchemeResult): number {
        return typeof result.rowsWritten === "number" ? result.rowsWritten : 1;
    }

    // {§db-migrations} — a result read back from a row is parsed, never re-asserted: the
    // row's text is the result the gate admitted when it was written.
    static fromRow(stored: string): SchemeResult {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§db-migrations}: a stored result is parsed, not re-asserted
        return JSON.parse(stored) as SchemeResult;
    }

    // {§outside-text} — extension members added to a failure already built. Only a failed
    // result carries a problem to extend; anything else is a contract violation, not a no-op.
    static extend<T extends SchemeResult>(result: T, extensions: Readonly<Record<string, unknown>>): T {
        if (result.problem === undefined) throw new TypeError("only a failed result carries extension members");
        return Results.assert({ ...result, problem: { ...result.problem, ...extensions } });
    }
}
