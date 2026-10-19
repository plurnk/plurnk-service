import { Results as _Results } from "@plurnk/plurnk-schemes";
import type ConfigurationError from "@plurnk/plurnk-meta/configuration-error";
import type {
    ChannelProducerResult, EntryResult, MatchEvidence, ProblemDetails, ProposalResult, PassthroughResult, RepresentationPreparationResult, SchemeResult, SchemeResultBase,
} from "@plurnk/plurnk-schemes";

export type { ChannelProducerResult, EntryResult, MatchEvidence, ProblemDetails, ProposalResult, PassthroughResult, RepresentationPreparationResult, SchemeResult, SchemeResultBase };

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

export default class Results {
    // {§configuration-repair-path}: invalid configuration is unavailable, never an invented policy.
    static configurationFailure(cause: ConfigurationError): SchemeResult {
        return Results.failure("daemon:configuration", "configuration-invalid", 503, cause.message, {}, {
            key: cause.key,
            retryable: false,
        });
    }

    static isEntryResult(r: SchemeResult): r is EntryResult { return _Results.isEntry(r); }
    static isProposalResult(r: SchemeResult): r is ProposalResult { return _Results.isProposal(r); }
    static isPassthroughResult(r: SchemeResult): r is PassthroughResult { return _Results.isPassthrough(r); }

    static isErrorStatus(status: number): boolean { return _Results.isErrorStatus(status); }

    static problem(
        owner: string,
        code: string,
        status: number,
        detail: string,
        extensions: Readonly<Record<string, unknown>> = {},
    ): ProblemDetails {
        return _Results.problem(owner, code, status, detail, extensions);
    }

    static failure(owner: string, code: string, status: number, detail: string): SchemeResult;
    static failure<F extends Readonly<Record<string, unknown>>>(
        owner: string,
        code: string,
        status: number,
        detail: string,
        fields: F,
        extensions?: Readonly<Record<string, unknown>>,
    ): SchemeResult & F;
    static failure(
        owner: string,
        code: string,
        status: number,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): SchemeResult {
        return _Results.failure(owner, code, status, detail, fields, extensions);
    }

    static assert<T extends SchemeResult>(result: T): T { return _Results.assert(result); }

    static isFailed(result: SchemeResult): result is FailedResult {
        return _Results.isErrorStatus(result.status) && result.problem !== undefined;
    }

    // The log rows an operation wrote: the result says when more than its own row landed.
    static rowsWritten(result: SchemeResult): number {
        return typeof result.rowsWritten === "number" ? result.rowsWritten : 1;
    }

    // {§validation-topology} — a result read back from a row is parsed, never re-asserted: the
    // row's text is the result the gate admitted when it was written.
    static fromRow(stored: string): SchemeResult {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§validation-topology}: a stored result is parsed, not re-asserted
        return JSON.parse(stored) as SchemeResult;
    }

    // {§terminal-evidence} — extension members added to a failure already built. Only a failed
    // result carries a problem to extend; anything else is a contract violation, not a no-op.
    static extend<T extends SchemeResult>(result: T, extensions: Readonly<Record<string, unknown>>): T {
        if (result.problem === undefined) throw new TypeError("only a failed result carries extension members");
        return _Results.assert({ ...result, problem: { ...result.problem, ...extensions } });
    }

    static assertReadResult<T extends SchemeResult>(result: T): T {
        return _Results.assertReadResult(result);
    }

    static assertRepresentationPreparation<T extends RepresentationPreparationResult>(result: T): T {
        return _Results.assertRepresentationPreparation(result);
    }

    static assertChannelProducerResult<T extends ChannelProducerResult>(result: T): T {
        return _Results.assertChannelProducerResult(result);
    }

    static assertMatchEvidenceList(evidence: unknown): ReadonlyArray<MatchEvidence> {
        return _Results.assertMatchEvidenceList(evidence);
    }

    static attachInstance<T extends SchemeResult>(result: T, instance: string): T {
        return _Results.attachInstance(result, instance);
    }
}
