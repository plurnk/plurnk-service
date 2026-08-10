import { Results as _Results } from "@plurnk/plurnk-schemes";
import type {
    ChannelProducerResult, EntryResult, MatchEvidence, ProblemDetails, ProposalResult, PassthroughResult, RepresentationPreparationResult, SchemeResult, SchemeResultBase,
} from "@plurnk/plurnk-schemes";

export type { ChannelProducerResult, EntryResult, MatchEvidence, ProblemDetails, ProposalResult, PassthroughResult, RepresentationPreparationResult, SchemeResult, SchemeResultBase };

export class OperationFailureError extends Error {
    readonly result: SchemeResult & { readonly problem: ProblemDetails };

    constructor(result: SchemeResult, options: { cause?: unknown } = {}) {
        const checked = _Results.assert(result);
        if (!_Results.isErrorStatus(checked.status) || checked.problem === undefined) {
            throw new TypeError("OperationFailureError requires a failed operation result");
        }
        super(
            checked.problem.detail,
            options.cause !== undefined ? { cause: options.cause } : undefined,
        );
        this.name = "OperationFailureError";
        this.result = checked as SchemeResult & { readonly problem: ProblemDetails };
    }
}

export default class Results {
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
